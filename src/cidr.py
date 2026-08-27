# Limooo - 统一 IP/CIDR 规范化与匹配工具
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

"""VPS 侧 IP/CIDR 唯一规范化实现。

Pages Functions 侧对应 ``functions/_lib/cidr.ts``；两端函数名与语义保持一致。
所有入库 CIDR 都必须经过这里，输出统一为 ``<network>/<prefix>`` 形式：

* IPv4: ``1.2.3.4/32``、``1.2.3.0/24``
* IPv6: ``2001:db8::1/128``、``2001:db8::/64``
"""

from __future__ import annotations

import ipaddress
import re


def normalize_ip(value: str) -> str | None:
    """把单个 IP 转成 canonical 字符串；非法地址返回 ``None``。"""
    try:
        return ipaddress.ip_address(value.strip()).compressed
    except ValueError:
        return None


def parse_cidr(value: str) -> tuple[str, int] | None:
    """解析 CIDR/裸 IP，返回 ``(network_address, prefixlen)``。

    * ``1.2.3`` 视为 ``1.2.3.0/24``（auto_block 历史格式）
    * ``1.2.3.4`` 视为 ``1.2.3.4/32``
    * ``2001:db8::1`` 视为 ``2001:db8::1/128``
    * 行尾 ``#`` 注释会被忽略
    """
    raw = re.sub(r"#.*$", "", value).strip()
    if not raw:
        return None
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){2}", raw):
        raw = f"{raw}.0/24"
    try:
        network = ipaddress.ip_network(raw, strict=False)
    except ValueError:
        return None
    return str(network.network_address), network.prefixlen


def normalize_cidr(value: str) -> str | None:
    """把任意合法 CIDR/裸 IP 规范化为 ``<network>/<prefix>``。"""
    parsed = parse_cidr(value)
    if parsed is None:
        return None
    return f"{parsed[0]}/{parsed[1]}"


def network_address(ip: str, prefix: int) -> str | None:
    """返回给定 IP 所在指定前缀的网络地址（canonical）。"""
    try:
        address = ipaddress.ip_address(ip.strip())
    except ValueError:
        return None
    if prefix < 0 or prefix > address.max_prefixlen:
        return None
    return str(
        ipaddress.ip_network(f"{address}/{prefix}", strict=False).network_address
    )


def cidr_contains(cidr: str, ip: str) -> bool:
    """判断单个 IP 是否落在 CIDR 内；两端非法时返回 False。"""
    try:
        network = ipaddress.ip_network(cidr, strict=False)
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return address in network
