/** 门禁诊断信息：直接函数入口，与 config 同路径策略。 */

import { handleGateDiag } from "../_lib/gate";

export const onRequest = handleGateDiag;
