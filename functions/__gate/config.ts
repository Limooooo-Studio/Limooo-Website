/** 门禁运行时配置：直接函数入口，避免根级 middleware 路由缺失时前端拿不到 sitekey/i18n。 */

import { handleGateConfig } from "../_lib/gate";

export const onRequest = handleGateConfig;
