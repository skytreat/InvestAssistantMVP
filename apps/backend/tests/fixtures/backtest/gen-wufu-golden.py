#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 `wufu-golden.json` —— 验收锚点①（Python oracle）

⚠️ 依赖**仓库外**只读源文件（**不复制进仓库**）：
    默认路径：D:/Personal/Documents/投资/复盘/ETF策略/五福轮动ETF_v5.2.py
    sha256    = cc9a622b4eb61bc3b56fc6d3a98d064321f4aa61afeb81d68b00834a3d047e7d
    可用环境变量 `WUFU_SOURCE` 或第一个命令行参数覆盖。

运行：
    python apps/backend/tests/fixtures/backtest/gen-wufu-golden.py [源文件路径]
    然后跑 `npx prettier --write apps/backend/tests/fixtures/backtest/wufu-golden.json`
    （脚本输出是 `json.dump(indent=2)`，与本仓库 prettier 的 JSON 排版不完全一致）

做法：
1) 按「顶层 def 边界」从源文件抽取真函数
   - `calculate_momentum_score`（L687-L713，对应 L687-L711 实现体）
   - `get_volume_ratio`（L766-L788，对应 L766-L787 实现体）
   用 `exec(源码, 命名空间)` 跑真函数；命名空间注入 `np` / `math` / `g` 桩 / `log` 桩。
   `get_volume_ratio` 的 `context.current_dt` 固定 15:00：elapsed = (15-9)*60-30-90 = 240
   ⇒ 分时投影系数 240/240 = 1 ⇒ 即 §8.2 B2 的「日线等效」。
2) 用**独立 Python 转写**（本文件内的过滤 + 候选选择，不读 TS 实现）对 3 个合成交易日
   输出期望目标标的。
3) 写 JSON（浮点为 Python repr 全精度）。

口径标注：
- momentum 末点 = asOf 日收盘（B1：T-1 收盘决策）；
- 短期风控按 M3 规格用 `<=`（v5.2 原文是 `min(day_ratios) < g.loss`，见 M3 报告偏差说明）。
"""
import hashlib
import json
import math
import os
import sys
from datetime import datetime
from types import SimpleNamespace

import numpy as np

DEFAULT_SOURCE = r"D:\Personal\Documents\投资\复盘\ETF策略\五福轮动ETF_v5.2.py"
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wufu-golden.json")

# ─────────────────────────── 从源文件抽真函数 ───────────────────────────


def read_source(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    return raw.decode("utf-8").splitlines(True), hashlib.sha256(raw).hexdigest()


def extract_top_level_function(lines, name):
    """从顶层 `def name(` 抽到下一条顶层 `def`/`@` 之前的全部行（含 def 行）"""
    start = None
    for i, line in enumerate(lines):
        if line.startswith("def %s(" % name):
            start = i
            break
    if start is None:
        raise SystemExit("源文件里找不到顶层函数 %s" % name)
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("def ") or lines[j].startswith("@"):
            end = j
            break
    # 去掉尾部空行，行号按 1-based 闭区间报告
    while end > start + 1 and lines[end - 1].strip() == "":
        end -= 1
    return "".join(lines[start:end]), (start + 1, end)


class _ParamStub:
    volume_lookback = 5


class _LogStub:
    def debug(self, *args, **kwargs):
        pass

    def info(self, *args, **kwargs):
        pass

    def warning(self, *args, **kwargs):
        pass


def build_oracle(path):
    lines, sha = read_source(path)
    ns = {
        "np": np,
        "math": math,
        "g": _ParamStub(),
        "log": _LogStub(),
    }
    momentum_src, momentum_lines = extract_top_level_function(lines, "calculate_momentum_score")
    volume_src, volume_lines = extract_top_level_function(lines, "get_volume_ratio")
    exec(compile(momentum_src, "<v5.2:calculate_momentum_score>", "exec"), ns)  # noqa: S102
    exec(compile(volume_src, "<v5.2:get_volume_ratio>", "exec"), ns)  # noqa: S102
    return {
        "sha256": sha,
        "momentum": ns["calculate_momentum_score"],
        "volume_ratio": ns["get_volume_ratio"],
        "momentum_lines": momentum_lines,
        "volume_lines": volume_lines,
    }


# ─────────────────────────── 合成数据（纯确定性，无随机） ───────────────────────────


def geo(start, daily, n, wobble=0.0):
    """几何趋势 + 正弦扰动（确定性），保留 6 位小数便于阅读"""
    return [
        round(start * math.exp(daily * i) * (1.0 + wobble * math.sin(i * 1.7)), 6)
        for i in range(n)
    ]


LOOKBACK = 25
VOLUME_LOOKBACK = 5
MA_LOOKBACK = 10
MAX_WEAK_DAYS = 20
PARAMS = {
    "holdingsNum": 1,
    "minScore": 0.0,
    "maxScore": 5.0,
    "r2Threshold": 0.4,
    "maThreshold": 1.0,
    "volumeRatioThreshold": 1.8,
    "lossThreshold": 0.97,
    "scoreThresholdRatio": 0.9,
}
INDEX_CODES = ["sh000300", "sz399101", "sz399006", "sh000510"]
CTX_1500 = SimpleNamespace(current_dt=datetime(2024, 3, 6, 15, 0))
# 由 main() 注入的 v5.2 真函数（`calculate_momentum_score`）
MAC_ORACLE = None


def momentum_cases(oracle):
    """3 个价格族 × 3 个交易日（t=25/26/27）"""
    families = [
        ("strong-up", geo(10.0, 0.005, 30, 0.004)),
        ("down", geo(20.0, -0.0028, 30, 0.004)),
        ("choppy", geo(12.0, 0.0005, 30, 0.03)),
    ]
    out = []
    for name, series in families:
        for t in (25, 26, 27):
            window = series[t - LOOKBACK : t + 1]
            score, annualized, r2 = oracle["momentum"](window, LOOKBACK)
            out.append(
                {
                    "case": "%s@t%d" % (name, t),
                    "prices": window,
                    "expected": {
                        "annualized": float(annualized),
                        "r2": float(r2),
                        "score": float(score),
                    },
                }
            )
    return out


def ma_cases():
    series = {
        "ma-rising": [10.0 + 0.1 * i for i in range(11)],
        "ma-falling": [12.0 - 0.1 * i for i in range(11)],
        "ma-flat-last-spike": [10.0] * 10 + [10.8],
    }
    return [
        {
            "case": name,
            "closes": closes,
            "expected": float(np.mean(closes[-MA_LOOKBACK:])),
            "note": "MA(10) 取最后 10 个收盘（含当日），与 v5.2 L806 一致",
        }
        for name, closes in series.items()
    ]


def volume_ratio_cases(oracle):
    cases = [
        ("normal-1.15x", [1000.0, 1100.0, 900.0, 1050.0, 1000.0], 1200.0),
        ("zero-in-history", [1000.0, 0.0, 900.0, 1050.0, 1000.0], 1200.0),
        ("insufficient-history", [1000.0, 1100.0, 900.0, 1050.0], 1200.0),
    ]
    out = []
    for name, past5, today in cases:
        ratio = oracle["volume_ratio"](np.array(past5, dtype=float), today, CTX_1500, VOLUME_LOOKBACK)
        out.append(
            {
                "case": name,
                "past5": past5,
                "today": today,
                "expected": None if ratio is None else float(ratio),
            }
        )
    return out


# ─────────────────── 独立转写：过滤 + 候选选择（不读 TS） ───────────────────


def momentum_of(closes):
    """L717-L721 的数据门槛 + 真函数打分"""
    if len(closes) < LOOKBACK + 1:
        return None
    if len(closes) < LOOKBACK * 0.8:
        return None
    score, annualized, r2 = None, None, None
    try:
        score, annualized, r2 = MAC_ORACLE(closes, LOOKBACK)
    except Exception:
        return None
    if score is None:
        return None
    return float(score), float(annualized), float(r2)


def update_weak(prev_weak, prev_start, day_index, index_closes, params):
    """L789-L861 的单日推进（转写，语义同 TS 实现）"""
    above = below = 0
    for code in INDEX_CODES:
        closes = index_closes[code]
        if len(closes) < MA_LOOKBACK:
            continue
        current = closes[-1]
        ma = float(np.mean(closes[-MA_LOOKBACK:]))
        if current > ma:
            above += 1
        if current < ma:
            below += 1
    weak, start = prev_weak, prev_start
    days_before = (day_index - start + 1) if (weak and start is not None) else 0
    if weak:
        if days_before >= MAX_WEAK_DAYS:
            weak, start = False, None
        elif above >= 3:
            weak, start = False, None
        elif below >= 3:
            start = day_index
    elif below >= 3:
        weak, start = True, day_index
    days = (day_index - start + 1) if (weak and start is not None) else 0
    return weak, start, days, below, above


def metrics_of(symbol, spec, weak, params, volume_fn):
    """L714-L760 + L864-L876 的过滤链（转写）"""
    if spec.get("paused"):
        return None
    closes = spec["closes"]
    momentum = momentum_of(closes)
    if momentum is None:
        return None
    score, annualized, r2 = momentum
    if not (params["minScore"] <= score <= params["maxScore"]):
        return None
    if len(closes) >= 4:
        ratios = [closes[-1] / closes[-2], closes[-2] / closes[-3], closes[-3] / closes[-4]]
        if min(ratios) <= params["lossThreshold"]:
            return None
    volume_ratio = volume_fn(
        np.array(spec["past5"], dtype=float), spec["today"], CTX_1500, VOLUME_LOOKBACK
    )
    if not (volume_ratio is not None and volume_ratio < params["volumeRatioThreshold"]):
        return None
    ma = float(np.mean(closes[-MA_LOOKBACK:])) if len(closes) >= MA_LOOKBACK else None
    if not weak:
        if not (r2 > params["r2Threshold"]):
            return None
    elif ma is None or not (closes[-1] > ma * params["maThreshold"]):
        return None
    return {
        "symbol": symbol,
        "score": score,
        "annualized": annualized,
        "r2": r2,
        "volumeRatio": None if volume_ratio is None else float(volume_ratio),
        "ma": ma,
        "close": closes[-1],
    }


def select_targets(case, weak, params, volume_fn):
    """L974-L1060 的候选/保留/防御（转写）"""
    pool = list(case["universe"]["weak"]) if weak else list(case["universe"]["fixed"]) + list(
        case["universe"]["dynamic"]
    )
    seen = set()
    pool = [s for s in pool if not (s in seen or seen.add(s))]
    metrics = []
    for symbol in pool:
        spec = case["symbols"].get(symbol)
        if spec is None:
            continue
        m = metrics_of(symbol, spec, weak, params, volume_fn)
        if m is not None:
            metrics.append(m)
    metrics.sort(key=lambda m: (-m["score"], m["symbol"]))
    top10 = metrics[:10]
    if len(top10) >= params["holdingsNum"]:
        reference = top10[params["holdingsNum"] - 1]["score"]
        ratio = 1.0 if weak else params["scoreThresholdRatio"]
        candidates = [m for m in top10 if m["score"] >= reference * ratio]
    else:
        candidates = list(top10)

    by_symbol = {m["symbol"]: m for m in candidates}
    retained = [by_symbol[s] for s in case.get("holds", []) if s in by_symbol]
    retained.sort(key=lambda m: -m["score"])
    if len(retained) >= params["holdingsNum"]:
        picks = retained[: params["holdingsNum"]]
    else:
        retained_syms = {m["symbol"] for m in retained}
        additional = [m for m in candidates if m["symbol"] not in retained_syms]
        picks = retained + additional[: params["holdingsNum"] - len(retained)]
    expected = [m["symbol"] for m in picks]
    defensive = False
    defensive_paused = case["symbols"].get(case["defensiveEtf"], {}).get("paused", True)
    if not expected and not defensive_paused:
        expected = [case["defensiveEtf"]]
        defensive = True
    return expected, defensive, top10, candidates


def target_selection_cases(oracle):
    normal_index = {
        code: geo(4000.0, 0.002, 11)
        for code in INDEX_CODES
    }
    weak_index = {
        "sh000300": geo(4000.0, -0.004, 11),
        "sz399101": geo(4100.0, -0.004, 11),
        "sz399006": geo(2500.0, -0.004, 11),
        "sh000510": geo(3900.0, 0.004, 11),
    }
    flat_defensive = {
        "closes": [100.0] * 26,
        "past5": [1_000_000.0] * 5,
        "today": 1_000_000.0,
        "paused": False,
    }
    strong = geo(10.0, 0.006, 26, 0.002)
    medium = geo(10.0, 0.004, 26, 0.002)
    choppy = geo(10.0, 0.0005, 26, 0.03)
    volume_spike = geo(10.0, 0.0065, 26, 0.002)
    loss_day = geo(10.0, 0.007, 26, 0.002)
    loss_day[-1] = round(loss_day[-1] * 0.96, 6)
    falling = geo(20.0, -0.003, 26, 0.004)

    steady_vol = {"past5": [1_000_000.0] * 5, "today": 1_000_000.0, "paused": False}

    cases = [
        {
            "asOf": "2024-03-05",
            "execDate": "2024-03-06",
            "dayIndex": 0,
            "priorWeak": False,
            "priorWeakStart": None,
            "universe": {
                "fixed": ["sh512880", "sh510300", "sz159915", "sh512690", "sh515790"],
                "dynamic": [],
                "weak": [],
            },
            "holds": [],
            "indexCloses": normal_index,
            "defensiveEtf": "sh511880",
            "symbols": {
                "sh512880": {"closes": strong, **steady_vol},
                "sh510300": {"closes": medium, **steady_vol},
                "sz159915": {"closes": choppy, **steady_vol},
                "sh512690": {"closes": volume_spike, "past5": [1_000_000.0] * 5, "today": 2_000_000.0, "paused": False},
                "sh515790": {"closes": loss_day, **steady_vol},
                "sh511880": flat_defensive,
            },
            "note": "正常期：R²/量比/短期风控各淘汰一只，仅 sh512880 入选",
        },
        {
            "asOf": "2024-03-06",
            "execDate": "2024-03-07",
            "dayIndex": 0,
            "priorWeak": False,
            "priorWeakStart": None,
            "universe": {
                "fixed": ["sh512880", "sh510300"],
                "dynamic": [],
                "weak": [],
            },
            "holds": ["sh510300"],
            "indexCloses": normal_index,
            "defensiveEtf": "sh511880",
            "symbols": {
                "sh512880": {"closes": strong, **steady_vol},
                "sh510300": {"closes": medium, **steady_vol},
                "sh511880": flat_defensive,
            },
            "note": "正常期系数 0.9：持仓 sh510300 分数 0.71× 第一名 → 掉出候选 → 换仓",
        },
        {
            "asOf": "2024-03-07",
            "execDate": "2024-03-08",
            "dayIndex": 0,
            "priorWeak": False,
            "priorWeakStart": None,
            "universe": {
                "fixed": ["sh512880"],
                "dynamic": [],
                "weak": ["sh512690"],
            },
            "holds": ["sh512880"],
            "indexCloses": weak_index,
            "defensiveEtf": "sh511880",
            "symbols": {
                "sh512690": {"closes": falling, **steady_vol},
                "sh511880": flat_defensive,
            },
            "note": "走弱期：3/4 指数低于 MA10 → weak 池仅一只且分数为负 → 防御 ETF",
        },
    ]

    out = []
    for case in cases:
        weak, _start, days, below, above = update_weak(
            case["priorWeak"],
            case["priorWeakStart"],
            case["dayIndex"],
            case["indexCloses"],
            PARAMS,
        )
        expected, defensive, top10, candidates = select_targets(
            case, weak, PARAMS, oracle["volume_ratio"]
        )
        out.append(
            {
                "asOf": case["asOf"],
                "execDate": case["execDate"],
                "expectedSymbols": expected,
                "expectedRegime": "weak" if weak else "normal",
                "expectedWeakDays": days,
                "expectedDefensive": defensive,
                "indexCounts": {"below": below, "above": above},
                "top10": [m["symbol"] for m in top10],
                "candidates": [m["symbol"] for m in candidates],
                "inputs": {
                    "dayIndex": case["dayIndex"],
                    "priorWeak": case["priorWeak"],
                    "priorWeakStart": case["priorWeakStart"],
                    "universe": case["universe"],
                    "holds": case["holds"],
                    "indexCloses": case["indexCloses"],
                    "defensiveEtf": case["defensiveEtf"],
                    "symbols": case["symbols"],
                },
                "note": case["note"],
            }
        )
    return out


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("WUFU_SOURCE", DEFAULT_SOURCE)
    global MAC_ORACLE
    oracle = build_oracle(source)
    MAC_ORACLE = oracle["momentum"]

    payload = {
        "source": "五福轮动ETF_v5.2.py sha256=%s" % oracle["sha256"],
        "generator": "apps/backend/tests/fixtures/backtest/gen-wufu-golden.py",
        "functionLines": {
            "calculate_momentum_score": list(oracle["momentum_lines"]),
            "get_volume_ratio": list(oracle["volume_lines"]),
        },
        "mode": {
            "decision": "T-1 close (B1)",
            "volume": "full-day, no intraday projection (B2)",
        },
        "params": {
            "lookbackDays": LOOKBACK,
            "volumeLookback": VOLUME_LOOKBACK,
            "maLookback": MA_LOOKBACK,
            "maxWeakDays": MAX_WEAK_DAYS,
            **PARAMS,
        },
        "momentum": momentum_cases(oracle),
        "ma": ma_cases(),
        "volumeRatio": volume_ratio_cases(oracle),
        "targetSelection": target_selection_cases(oracle),
    }

    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print("wrote %s" % OUT_PATH)
    print(
        "momentum=%d ma=%d volumeRatio=%d targetSelection=%d"
        % (
            len(payload["momentum"]),
            len(payload["ma"]),
            len(payload["volumeRatio"]),
            len(payload["targetSelection"]),
        )
    )


if __name__ == "__main__":
    main()
