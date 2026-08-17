const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.TARGET_SUPABASE_URL;
const serviceKey = process.env.TARGET_SUPABASE_SERVICE_ROLE_KEY;
const inputRoot = process.env.BACKUP_STORAGE_DIR || 'backup/storage';

if (!url || !serviceKey) {
  console.error('Faltan TARGET_SUPABASE_URL o TARGET_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(inputRoot, 'storage-manifest.json'), 'utf8'));
  const { data: existing, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;
  const existingIds = new Set((existing || []).map((bucket) => bucket.id));

  let restored = 0;
  for (const bucket of manifest.buckets || []) {
    if (!existingIds.has(bucket.id)) {
      const { error: createError } = await supabase.storage.createBucket(bucket.id, {
        public: Boolean(bucket.public),
        fileSizeLimit: bucket.fileSizeLimit || undefined,
        allowedMimeTypes: bucket.allowedMimeTypes || undefined,
      });
      if (createError) throw createError;
    }

    for (const object of bucket.objects || []) {
      const source = path.join(inputRoot, bucket.id, ...object.path.split('/'));
      const buffer = await fs.readFile(source);
      const contentType = object.metadata?.mimetype || object.metadata?.contentType || 'application/octet-stream';
      const { error: uploadError } = await supabase.storage.from(bucket.id).upload(object.path, buffer, {
        contentType,
        upsert: true,
      });
      if (uploadError) throw uploadError;
      restored += 1;
    }
  }

  console.log(`Storage restaurado: ${restored} objetos`);
}

main().catch((error) => {
  console.error('Error restaurando Storage:', error.message);
  process.exit(1);
});
