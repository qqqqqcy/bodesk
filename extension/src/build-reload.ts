const alarmName = 'boss-helper-build';
const revisionKey = 'bossHelper.buildRevision';
const pagePatterns = ['/web/*', '/job_detail/*', '/gongsi/job/*.html*'];
const mockPages = ['http://127.0.0.1:4173', 'http://localhost:4173'].flatMap(origin => pagePatterns.map(path => origin + path));
const sitePages = [...mockPages, ...pagePatterns.map(path => 'https://www.zhipin.com' + path)];

export function registerBuildReload(whenIdle: (reload: () => Promise<void>) => Promise<void>) {
  let checking = false;

  async function check() {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch(chrome.runtime.getURL('dist/revision.txt') + '?check=' + Date.now(), {cache: 'no-store'});
      if (!response.ok) return;
      const revision = (await response.text()).trim();
      if (!/^[a-f0-9]{64}$/.test(revision)) return;
      const previous = (await chrome.storage.local.get(revisionKey))[revisionKey] as {revision: string; refreshMock?: boolean} | undefined;
      if (!previous) {
        await chrome.storage.local.set({[revisionKey]: {revision}});
        return;
      }
      if (previous.refreshMock) {
        await chrome.storage.local.set({[revisionKey]: {revision: previous.revision}});
        const tabs = await chrome.tabs.query({url: mockPages});
        await Promise.allSettled(tabs.flatMap(tab => tab.id === undefined ? [] : [chrome.tabs.reload(tab.id)]));
      }
      if (previous.revision === revision) return;
      const tabs = await chrome.tabs.query({url: sitePages});
      const replies = await Promise.all(tabs.map(async tab => {
        if (tab.id === undefined) return;
        try {return await chrome.tabs.sendMessage(tab.id, {type: 'BUILD_RELOAD_READY'}, {frameId: 0});} catch {}
      }));
      if (replies.some(reply => reply?.ready === false)) return;
      await whenIdle(async () => {
        await chrome.storage.local.set({[revisionKey]: {revision, refreshMock: true}});
        chrome.runtime.reload();
      });
    } catch {} finally {
      checking = false;
    }
  }

  chrome.alarms.onAlarm.addListener(alarm => {if (alarm.name === alarmName) void check();});
  void (async () => {
    if (!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName, {periodInMinutes: 0.5});
    await check();
  })().catch(() => {});
}
