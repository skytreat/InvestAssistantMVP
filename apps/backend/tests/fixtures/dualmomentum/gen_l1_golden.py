"""生成 DualMomentum L1 指标 golden（产物入库为测试 fixture，勿手工改）。

用法（需 numpy，且本机有 QuantInvest 参考实现）：
    python gen_l1_golden.py
环境变量：
    QUANTINVEST_DIR  参考实现目录，默认 d:/workspace/QuantInvest/Strategy/DualMomentum/JointQuant
"""
import json
import math
import os
import sys

QUANTINVEST_DIR = os.environ.get(
    'QUANTINVEST_DIR', r'd:/workspace/QuantInvest/Strategy/DualMomentum/JointQuant'
)
sys.path.insert(0, QUANTINVEST_DIR)

from indicators import (  # noqa: E402
    calc_ma,
    calc_nday_return_momentum,
    calc_rsrs,
    calc_weighted_slope_momentum,
)

N = 80
WINDOW = 60  # = max(25, 25, 25+25, 60)
closes = []
highs = []
lows = []
for i in range(N):
    drift = 0.0006 * i
    cycle = 0.03 * math.sin(i / 7.0)
    close = 3.0 * math.exp(drift + cycle)
    high = close * (1.003 + 0.002 * abs(math.sin(i / 5.0)))
    low = close * (0.997 - 0.002 * abs(math.cos(i / 9.0)))
    closes.append(close)
    highs.append(high)
    lows.append(low)

cases = []
for end in range(N):
    start = max(0, end - WINDOW + 1)
    c = closes[start:end + 1]
    h = highs[start:end + 1]
    lo = lows[start:end + 1]
    if len(c) < WINDOW:
        continue
    cases.append({
        'end': end,
        'wsm_v2': calc_weighted_slope_momentum(c[-25:]),
        'nday_return': calc_nday_return_momentum(c, 25),
        'rsrs_z': calc_rsrs(h[-50:], lo[-50:], 25, 25),
        'ma5': calc_ma(c, 5),
        'ma10': calc_ma(c, 10),
        'ma20': calc_ma(c, 20),
        'ma60': calc_ma(c, 60),
    })

out = {
    'generated_from': 'QuantInvest/indicators.py',
    'bars': [
        {
            'date': f'2020-01-{i + 1:02d}',
            'open': (closes[i] + lows[i]) / 2,
            'high': highs[i],
            'low': lows[i],
            'close': closes[i],
            'volume': 1000 + i,
            'hfq_factor': 1.0,
        }
        for i in range(N)
    ],
    'cases': cases,
}

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'l1_indicator_golden.json')
with open(path, 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=2)
print('wrote', path, 'cases=', len(cases))
