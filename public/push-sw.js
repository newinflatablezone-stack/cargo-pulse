self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; }
  catch { payload = { title: 'Cargo Pulse', body: event.data?.text() || '工单有新动态' }; }
  event.waitUntil(self.registration.showNotification(payload.title || 'Cargo Pulse', {
    body: payload.body || '',
    icon: '/brand-logo.png',
    badge: '/brand-logo.png',
    tag: payload.tag || undefined,
    renotify: true,
    data: { url: payload.url || '/?resource=tickets' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/?resource=tickets', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(target); return existing.focus(); }
    return clients.openWindow(target);
  })());
});
