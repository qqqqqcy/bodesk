import {createMockServer} from '../../../mock/server.js';

export async function clientFor(context) {
  const server = createMockServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
  const origin = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function request(path, data) {
    const response = await fetch(origin + path, {headers: {cookie, ...(data === undefined ? {} : {'content-type': 'application/json'})}, ...(data === undefined ? {} : {method: 'POST', body: JSON.stringify(data)})});
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  return {origin, request, json: async (path, data) => (await request(path, data)).json()};
}
