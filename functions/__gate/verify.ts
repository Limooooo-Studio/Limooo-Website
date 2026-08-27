/** Turnstile 验证：直接函数入口，POST 校验后签发 __gate cookie。 */

import { handleVerify } from "../_lib/gate";

export const onRequest = handleVerify;
