// 这个域名上以前是一个博客，它注册过 Service Worker，会把旧页面缓存起来、优先读缓存。
// 新站不用 Service Worker：老访客的浏览器取到这个文件后，会清掉旧缓存、注销自己，并刷新到新页面。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key)
    await self.registration.unregister()
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url)
  })())
})
