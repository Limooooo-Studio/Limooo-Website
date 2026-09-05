# 门禁诊断字体

Maple Mono NF CN Regular 的门禁衍生版，仅新增 `위` / `치`（U+C704 / U+CE58），不是完整韩文字库。原有 41,617 个字形轮廓和水平度量逐项校验保持不变；新字形为 1000 UPM、1200 advance、圆头 Regular 笔画，使用无 hinting 的 WOFF2。

字体二进制仅存本地外部字体目录与 R2，不放 Git 或 Pages。源字体及衍生字体遵循本目录 `OFL.txt`。

```sh
.venv-build/bin/python ops/fonts/build_gate_font.py \
  /Users/lime/Documents/Project/Fonts/MapleMono-NF-CN/MapleMono-NF-CN-Regular.ttf \
  /Users/lime/Documents/Project/Fonts/MapleMono-Gate-KR
```

输出完整 Regular TTF 与仅含诊断文案所需字符的 WOFF2。字体仍保留原家族名。R2 桶为 `limooo-fonts`，公开资源为 `https://fonts.limooo.cn/maple-mono-nf-cn-regular-subset.woff2`；OFL 同目录公开。CORS 允许页面跨域读取字体。
