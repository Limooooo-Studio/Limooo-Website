---
title: Video platform inventory
description: Operating entity, registered address and privacy policy entry point for Douyin, Xiaohongshu, Bilibili, WeChat Channels and YouTube.
---

# Video platform inventory

This page lists the **operating entity**, **registered address** and **official privacy policy**
for commonly used self-media platforms, for campaign, account-compliance and data-processing
due diligence.

> Checked on 2026-09-27. Entities and policy URLs change; always confirm against the official
> page before relying on an entry. This page is an index only and is not legal advice.

## Platforms

| Platform | Operating entity (legal name) | Location | Privacy policy |
| --- | --- | --- | --- |
| Douyin | Beijing Douyin Technology Co., Ltd. (北京抖音科技有限公司, formerly Beijing Microlive Vision Technology Co., Ltd.) | Room 2022, 2/F, Building 4, Courtyard A18, North Third Ring West Road, Haidian District, Beijing, China | <https://www.douyin.com/agreements/?id=6773906068725565448> |
| Xiaohongshu (RED) | Xingin Information Technology (Shanghai) Co., Ltd. (行吟信息科技（上海）有限公司) | Rooms C201–C207, Building C, SOHO Fuxing Plaza, 368 Madang Road, Huangpu District, Shanghai, China | <https://www.xiaohongshu.com/protocols/privacy> |
| Bilibili | Shanghai Kuanyu Digital Technology Co., Ltd. (上海宽娱数码科技有限公司) | 485 Zhengli Road, Yangpu District, Shanghai, China | <https://www.bilibili.com/blackboard/privacy-pc.html> |
| WeChat Channels (视频号) | Shenzhen Tencent Computer Systems Company Limited (深圳市腾讯计算机系统有限公司) | 35/F, Tencent Building, Kejizhong 1st Road, Maling Community, Yuehai Street, Nanshan District, Shenzhen, Guangdong, China | <https://privacy.qq.com/document/preview/fc748b3d96224fdb825ea79e132c1a56> |
| YouTube | Google LLC | 1600 Amphitheatre Parkway, Mountain View, CA 94043, USA | <https://policies.google.com/privacy> |

## Notes per platform

### Douyin (TikTok's mainland China counterpart)

- Operating entity: **Beijing Douyin Technology Co., Ltd.**, renamed in March 2024 from
  "Beijing Microlive Vision Technology Co., Ltd." (北京微播视界科技有限公司).
- Registered address: Room 2022, 2/F, Building 4, Courtyard A18, North Third Ring West Road,
  Haidian District, Beijing.
- The privacy policy also lists a separate postal contact: Legal Department, Data Security and
  Privacy Protection Center, Building A, Rong Center, Chaoyang District, Beijing.
- Privacy policy: <https://www.douyin.com/agreements/?id=6773906068725565448>

### Xiaohongshu / RED

- Operating entity: **Xingin Information Technology (Shanghai) Co., Ltd.** and its affiliates.
- Registered address: Rooms C201–C207, Building C, SOHO Fuxing Plaza, 368 Madang Road,
  Huangpu District, Shanghai.
- Note: mainland-China Xiaohongshu and its overseas version **rednote** are operated by
  different entities; this page covers Xiaohongshu only.
- Privacy policy: <https://www.xiaohongshu.com/protocols/privacy>

### Bilibili

- Operating entity: **Shanghai Kuanyu Digital Technology Co., Ltd.**, the registered operator of
  bilibili.com and an affiliate of Bilibili Inc.
- Registered address: 485 Zhengli Road, Yangpu District, Shanghai.
- Privacy policy: <https://www.bilibili.com/blackboard/privacy-pc.html>

### WeChat Channels

- Operating entity: **Shenzhen Tencent Computer Systems Company Limited**. WeChat Channels is a
  feature inside WeChat and does not have a separate operating entity.
- Registered address: 35/F, Tencent Building, Kejizhong 1st Road, Maling Community, Yuehai Street,
  Nanshan District, Shenzhen.
- Collection and use of Channels data is governed by the WeChat Privacy Protection Guidelines;
  there is no separate policy page.
- Privacy policy: <https://privacy.qq.com/document/preview/fc748b3d96224fdb825ea79e132c1a56>

### YouTube

- Operating entity: **Google LLC**, incorporated under the laws of Delaware, part of Alphabet.
- Address: 1600 Amphitheatre Parkway, Mountain View, CA 94043, USA.
- YouTube Terms of Service wording: "The entity providing the Service is Google LLC, a company
  operating under the laws of Delaware, located at 1600 Amphitheatre Parkway, Mountain View,
  CA 94043".
- Privacy policy: <https://policies.google.com/privacy>

## Language variants

This page exists in four languages; the URL prefixes match `supported_langs` in the main site's
`config-contract.json`:

| Language | Page |
| --- | --- |
| 简体中文 (default) | `/video-platform` |
| English | `/en-us/video-platform` |
| 日本語 | `/ja-jp/video-platform` |
| 한국어 | `/ko-kr/video-platform` |

## Shared cookies with the main site

The docs site (`docs.limooo.cn`) and the main site (`limooo.cn`) share the `limooo.cn` domain, so
language and colour scheme stay in sync through `Domain=.limooo.cn` cookies:

| Cookie | Values | Purpose |
| --- | --- | --- |
| `user_lang_preference` | `zh-cn` / `en-us` / `ja-jp` / `ko-kr` | Written when the docs language changes; the main site renders that language |
| `limooo_theme` | `light` / `dark` | Written when the docs theme changes; used by the main site to avoid a first-paint flash |

Behaviour:

- On the docs root path, if the main-site cookie already selects a non-Chinese language, the site
  redirects once per session to that language. Deep links that already carry a language prefix are
  never rewritten.
- Inside the docs site, localStorage takes precedence over the cookie; if the theme was never
  explicitly switched on the docs site, it follows the main site's `limooo_theme`.
- The docs site is unauthenticated and writes no identity credentials — only the two preference
  cookies above.
