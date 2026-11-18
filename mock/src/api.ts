export async function api<Result>(path: string, data?: unknown): Promise<Result> {
  const response = await fetch(path, data === undefined ? undefined : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(data)});
  if (!response.ok) throw new Error('模拟接口 HTTP ' + response.status);
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result;
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : '模拟操作失败';
