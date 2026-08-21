const sharp = require('sharp');

const MIME_TO_SHARP_FORMAT = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
});

const invalidFileError = (message = 'El archivo no coincide con el formato declarado.') => {
  const error = new Error(message);
  error.code = 'INVALID_FILE_SIGNATURE';
  error.status = 400;
  return error;
};

const assertImageBuffer = async (buffer, mimetype) => {
  const expectedFormat = MIME_TO_SHARP_FORMAT[mimetype];
  if (!expectedFormat || !Buffer.isBuffer(buffer) || buffer.length < 12) throw invalidFileError();

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
  } catch (_error) {
    throw invalidFileError('La imagen está dañada o no corresponde a un formato permitido.');
  }

  if (metadata?.format !== expectedFormat) {
    throw invalidFileError('La imagen no coincide con el tipo de archivo informado.');
  }

  if (!metadata.width || !metadata.height) {
    throw invalidFileError('La imagen no contiene dimensiones válidas.');
  }

  return metadata;
};

const assertPdfBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw invalidFileError('El PDF está vacío o no es válido.');
  const header = buffer.subarray(0, 5).toString('ascii');
  if (header !== '%PDF-') throw invalidFileError('El archivo no corresponde a un PDF válido.');
  return true;
};

const assertUploadedFile = async (file) => {
  if (!file?.buffer || !file?.mimetype) throw invalidFileError('No se recibió un archivo válido.');
  if (file.mimetype === 'application/pdf') return assertPdfBuffer(file.buffer);
  return assertImageBuffer(file.buffer, file.mimetype);
};

module.exports = {
  MIME_TO_SHARP_FORMAT,
  assertImageBuffer,
  assertPdfBuffer,
  assertUploadedFile,
};
