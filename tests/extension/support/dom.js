import {afterEach} from 'node:test';
import {JSDOM} from 'jsdom';

const windows = [];
afterEach(() => {for (const window of windows.splice(0)) window.close();});
export async function flush() {for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0));}

export function browserHarness(source, sendMessage, {confirm = () => true, url = 'https://www.zhipin.com/web/geek/chat', html = '<!doctype html><html><body><div id="root"></div></body></html>', storage} = {}) {
  const dom = new JSDOM(html, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  const {window} = dom;
  windows.push(window);
  const output = [], calls = [];
  let listener, tick;
  const addListener = window.addEventListener.bind(window);
  window.addEventListener = (name, handler, options) => {if (name === 'message') listener = handler; addListener(name, handler, options);};
  window.postMessage = event => output.push(event.data);
  window.confirm = confirm;
  window.setInterval = handler => {tick = handler; return 1;};
  window.chrome = {storage, runtime: {sendMessage: message => {
    const promise = Promise.resolve(sendMessage(structuredClone(message))).then(value => structuredClone(value));
    calls.push(promise);
    return promise;
  }, onMessage: {addListener() {}}}};
  window.HTMLElement.prototype.emit = async function(name) {
    const start = calls.length;
    if (name === 'input' || name === 'change') this._valueTracker?.setValue('__previous_value__');
    if (name === 'click') this.click();
    else this.dispatchEvent(new window.Event(name, {bubbles: true, cancelable: true}));
    await Promise.all(calls.slice(start));
    await flush();
  };
  window.eval(source);
  return {
    window, document: window.document, output, calls,
    widget: () => window.document.getElementById('boss-local-helper-widget'),
    tick: async () => {tick?.(); await flush();},
    visibility: async hidden => {Object.defineProperty(window.document, 'hidden', {configurable: true, value: hidden}); window.document.dispatchEvent(new window.Event('visibilitychange')); await flush();},
    deliver: async data => {await listener({source: window, origin: window.location.origin, data: {channel: 'boss-local-helper-v1', direction: 'to-extension', data}}); await flush();},
  };
}
