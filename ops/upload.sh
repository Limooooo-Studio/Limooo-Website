#!/bin/bash

# Limooo - Flask Web Application
#
# Copyright (C) 2026 Limooo <https://limooo.cn/>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

# limooo.cn 部署脚本（兼容入口）—— docs/17 零 VPS 版
#
# README 早已把本文件描述为 "compatibility entry point → deploy.sh"，
# 但它曾是一份 300 行的 deploy.sh 拷贝（含 VPS 时代的 ssh/rsync/nginx），
# 两处逻辑必然漂移。现在它真的只做转发，参数语义与 ops/deploy.sh 一致：
#
#   bash ops/upload.sh                          # 部署 Pages
#   bash ops/upload.sh --commit --push          # 提交并推送
#   bash ops/upload.sh --all                    # 提交 + 推送 + 部署 Pages
#   bash ops/upload.sh --worker=status-worker   # 只部署某个独立 Worker
#
# 与 deploy.sh 的唯一差异：本入口给每行输出加 [upload] 前缀并收敛噪声，
# 便于把冗长的构建/部署日志折起来看。需要完整输出请直接用 ops/deploy.sh。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

exec bash "$ROOT/ops/deploy.sh" "$@"
