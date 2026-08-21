const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { assertImageBuffer, assertPdfBuffer, assertUploadedFile } = require('../services/fileValidation');

test('acepta una imagen PNG real con MIME PNG', async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 40, g: 158, b: 157, alpha: 1 } },
  }).png().toBuffer();

  const metadata = await assertImageBuffer(png, 'image/png');
  assert.equal(metadata.format, 'png');
});

test('rechaza una imagen cuyo contenido no coincide con el MIME declarado', async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();

  await assert.rejects(() => assertImageBuffer(png, 'image/jpeg'), (error) => {
    assert.equal(error.code, 'INVALID_FILE_SIGNATURE');
    assert.equal(error.status, 400);
    return true;
  });
});

test('acepta un PDF que declara firma PDF', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
  assert.equal(assertPdfBuffer(pdf), true);
});

test('rechaza contenido arbitrario disfrazado de PDF', async () => {
  await assert.rejects(
    () => assertUploadedFile({ mimetype: 'application/pdf', buffer: Buffer.from('<html>no es pdf</html>') }),
    (error) => {
      assert.equal(error.code, 'INVALID_FILE_SIGNATURE');
      assert.equal(error.status, 400);
      return true;
    },
  );
});
