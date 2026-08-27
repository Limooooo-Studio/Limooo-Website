/**
 * 访客列表状态筛选纯函数（浏览器 ESM）。
 *
 * 该模块不访问 DOM、不发网络请求，便于在 Vitest 中直接测试。
 *
 * 约定：
 * - status 为 'all' 时返回原数组的拷贝；
 * - statuses 以字符串键保存（如 { "200": 3 }），调用方传入的 status
 *   也会被统一转为字符串比较；
 * - 不修改传入数组，保持原始顺序。
 */

export function filterMarkers(markers, status) {
  if (!Array.isArray(markers)) return [];

  const key = status == null || status === '' ? 'all' : String(status);
  if (key === 'all') return markers.slice();

  const numericKey = Number.isFinite(Number(key)) ? String(Number(key)) : null;
  return markers.filter((marker) => {
    const statuses = marker && marker.statuses ? marker.statuses : {};
    const value = statuses[key] || (numericKey ? statuses[numericKey] : undefined) || 0;
    return Number(value) > 0;
  });
}
