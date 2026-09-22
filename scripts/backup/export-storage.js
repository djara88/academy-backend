const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const outputRoot = process.env.BACKUP_STORAGE_DIR || 'backup/storage';

if (!url || !serviceKey) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const safe = (value) => String(value || '').replace(/[^a-zA-Z0-9._/-]/g, '_');

async function listRecursive(bucket, prefix = '') {
  const items = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    if (!data?.length) break;

    for (const item of data) {
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id || item.metadata) items.push({ path: fullPath, metadata: item.metadata || null });
      else items.push(...await listRecursive(bucket, fullPath));
    }

    if (data.length < limit) break;
    offset += data.length;
  }
  return items;
}

async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;

  const manifest = { generatedAt: new Date().toISOString(), buckets: [] };

  for (const bucket of buckets || []) {
    const files = await listRecursive(bucket.id);
    const bucketEntry = {
      id: bucket.id,
      name: bucket.name,
      public: Boolean(bucket.public),
      fileSizeLimit: bucket.file_size_limit || null,
      allowedMimeTypes: bucket.allowed_mime_types || null,
      objects: [],
    };

    for (const file of files) {
      const { data, error: downloadError } = await supabase.storage.from(bucket.id).download(file.path);
      if (downloadError) throw downloadError;
      const target = path.join(outputRoot, safe(bucket.id), ...file.path.split('/').map(safe));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const buffer = Buffer.from(await data.arrayBuffer());
      await fs.writeFile(target, buffer);
      bucketEntry.objects.push({ path: file.path, bytes: buffer.length, metadata: file.metadata });
    }

    manifest.buckets.push(bucketEntry);
  }

  await fs.writeFile(path.join(outputRoot, 'storage-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Storage exportado: ${manifest.buckets.reduce((sum, bucket) => sum + bucket.objects.length, 0)} objetos`);
}

main().catch((error) => {
  console.error('Error exportando Storage:', error.message);
  process.exit(1);
});
