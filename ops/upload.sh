#!/bin/bash

# Limooo - Cloudflare Pages 部署辅助脚本
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

# 兼容入口：完整部署逻辑已统一到 ops/deploy.sh，这里只做转发，
# 避免保留两套内容几乎相同的部署脚本。
exec "$(cd "$(dirname "$0")" && pwd)/deploy.sh" "$@"
