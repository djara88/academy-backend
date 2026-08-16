from pathlib import Path
p = Path('services/systemMonitor.js')
s = p.read_text()
needle = "const safeError = (error) => String(error?.message || 'Error de conexión').slice(0, 180);\n"
if 'sanitizeRoutePath' not in s:
    addition = """const sanitizeRoutePath = (value) => String(value || '')
  .split('?')[0]
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
  .replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:token')
  .replace(/\/\d{4,}(?=\/|$)/g, '/:id')
  .slice(0, 240);
"""
    s = s.replace(needle, needle + addition)
s = s.replace("ruta: path ? String(path).split('?')[0].slice(0, 240) : null,", "ruta: path ? sanitizeRoutePath(path) : null,")
s = s.replace("['Mercado Pago', /^https:\\/\\/link\\.mercadopago\\.cl\\//i.test(String(process.env.MERCADO_PAGO_PAYMENT_LINK || ''))],", "['Mercado Pago', /^https:\\/\\/link\\.mercadopago\\.cl\\//i.test(String(process.env.MERCADO_PAGO_PAYMENT_LINK || 'https://link.mercadopago.cl/smproweb'))],")
p.write_text(s)
