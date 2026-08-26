"""共享测试配置：把 src/ 加入模块路径，并屏蔽本机会读取生产密钥的路径。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

sys.path.insert(0, str(SRC))
sys.path.insert(0, str(ROOT))

# 测试只使用假密钥，绝不让导入 src/app.py 时读取真实 secrets/ 文件。
os.environ.setdefault("FLASK_SECRET_KEY", "test-only-flask-secret")
os.environ.setdefault("APPLEID_ENCRYPTION_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
os.environ.setdefault("AUTHENTIK_CLIENT_ID", "test-client-id")
os.environ.setdefault("AUTHENTIK_CLIENT_SECRET", "test-client-secret")
