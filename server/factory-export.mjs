import { open } from 'node:fs/promises';
import sharp from 'sharp';
import { buildFactoryOrderWorkbook, createFactoryExportQueue, factoryImageSources, isFactoryExportable, FACTORY_EXPORT_EMPTY_MESSAGE } from '../factory-order-export.js';

const imageLimit = 20 * 1024 * 1024;
const cacheLimit = 12 * 1024 * 1024;
const cache = new Map();
let cacheSize = 0;
const queueImage = createFactoryExportQueue(6);
const shopifyHosts = new Set(['cdn.shopify.com', 'cdn.shopifycdn.net']);

async function thumbnail(bytes) {
  const image = sharp(bytes, { limitInputPixels: 48_000_000, failOn: 'error' }).timeout({ seconds: 3 });
  const { data, info } = await image.rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' }).jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
  return { buffer: data, extension: 'jpeg', width: info.width, height: info.height };
}

async function localPhoto(file, signal) {
  const source = await open(file, 'r');
  try {
    const info = await source.stat();
    if (!info.isFile()) throw new Error('原图文件不存在');
    if (info.size > imageLimit) throw new Error('原图超过 20 MB');
    return await source.readFile({ signal });
  } finally {
    await source.close();
  }
}

async function shopifyPhoto(url, signal) {
  const source = new URL(url);
  if (!shopifyHosts.has(source.hostname) || source.port || source.username || source.password) {
    throw new Error('外部图片仅提供原链接');
  }
  const saved = cache.get(url);
  if (saved?.expires > Date.now()) return saved.photo;
  if (saved) {
    cache.delete(url);
    cacheSize -= saved.photo.buffer.length;
  }
  source.searchParams.set('width', '640');
  const response = await fetch(source, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`图片下载失败 (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > imageLimit) throw new Error('原图超过 20 MB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const photo = await thumbnail(Buffer.concat(chunks, size));
  const replaced = cache.get(url);
  if (replaced) cacheSize -= replaced.photo.buffer.length;
  while (cacheSize + photo.buffer.length > cacheLimit && cache.size) {
    const oldest = cache.keys().next().value;
    cacheSize -= cache.get(oldest).photo.buffer.length;
    cache.delete(oldest);
  }
  cache.set(url, { photo, expires: Date.now() + 60 * 60 * 1000 });
  cacheSize += photo.buffer.length;
  return photo;
}

function photoFailure(error, signal) {
  if (signal.aborted || error.name === 'TimeoutError' || /timeout/i.test(error.message)) return '处理图片超时';
  if (error.code === 'ENOENT') return '原上传图片已不可用';
  if (/^(外部图片|图片下载失败|原图)/.test(error.message)) return error.message;
  return '图片无法读取或转换';
}

export async function exportFactoryWorkbook(orders, { pathsFor, imageLink, uploadPath, signal }) {
  const lines = [];
  const photos = new Map();
  const pending = new Map();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  function image(source) {
    const key = source.path || source.url;
    if (!pending.has(key)) {
      pending.set(key, queueImage(async () => {
        try {
          deadline.throwIfAborted();
          const photo = source.path
            ? await thumbnail(await localPhoto(uploadPath(source.path), deadline))
            : await shopifyPhoto(source.url, deadline);
          return { ...photo, url: source.url };
        } catch (error) {
          return { url: source.url, text: photoFailure(error, deadline) };
        }
      }));
    }
    return pending.get(key);
  }
  for (const order of orders.filter(isFactoryExportable)) {
    const available = new Set(pathsFor(order.id));
    const products = Array.isArray(order.products) && order.products.length ? order.products : null;
    const productLines = products ? products.map((product, index) => ({
      ...order, ...product, id: `${order.id}:${index}`, shopify_image_urls: product.image_urls, image_urls: [],
      image_paths: product.image_paths || [], requirements: [product.requirements, product.blower].filter(Boolean).join(' / ')
    })) : [order];
    for (const line of productLines) {
      lines.push(line);
      const paths = Array.isArray(line.image_paths) ? [...new Set(line.image_paths)] : [...available];
      const urls = factoryImageSources(line);
      photos.set(line.id, Promise.all([
        ...urls.map(({ publicUrl }) => image({ url: publicUrl })),
        ...paths.map(path => available.has(path)
          ? image({ path, url: imageLink(path) })
          : { text: '原上传图片已不可用' })
      ]));
    }
  }
  if (!lines.length) throw Object.assign(new Error(FACTORY_EXPORT_EMPTY_MESSAGE), { status: 400 });
  const resolved = await Promise.all([...photos].map(async ([id, entries]) => [id, await entries]));
  signal.throwIfAborted();
  const buffer = await buildFactoryOrderWorkbook(lines, new Map(resolved));
  signal.throwIfAborted();
  return {
    buffer,
    failures: resolved.flatMap(([, entries]) => entries).filter(photo => photo.text).length
  };
}
