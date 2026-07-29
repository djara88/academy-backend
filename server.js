// ============================================================
// RUTAS PARA MATRÍCULA
// ============================================================

// 1. Crear tutor
app.post('/api/tutores', authMiddleware, async (req, res) => {
  try {
    const { nombre_completo, rut, telefono, email } = req.body;
    const { academia_id } = req.user;

    const { data, error } = await supabase
      .from('tutores')
      .insert([{ academia_id, nombre_completo, rut, telefono, email }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, id: data.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Subir foto a Supabase Storage
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se envió ningún archivo' });
    }

    const { academia_id } = req.user;
    const fileExt = req.file.originalname.split('.').pop();
    const fileName = `${academia_id}/${Date.now()}.${fileExt}`;

    const { data, error } = await supabase.storage
      .from('fotos_alumnos')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (error) throw error;

    const { data: publicUrl } = supabase.storage
      .from('fotos_alumnos')
      .getPublicUrl(fileName);

    res.json({ success: true, url: publicUrl.publicUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Crear jugador
app.post('/api/jugadores', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const jugadorData = { ...req.body, academia_id };

    const { data, error } = await supabase
      .from('jugadores')
      .insert([jugadorData])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, id: data.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Crear evaluación
app.post('/api/evaluaciones', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id, metricas } = req.body;

    const { data, error } = await supabase
      .from('evaluaciones')
      .insert([{
        academia_id,
        jugador_id,
        metricas_json: metricas,
        fecha_evaluacion: new Date().toISOString(),
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Crear ficha médica
app.post('/api/ficha-medica', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const fichaData = { ...req.body, academia_id };

    const { data, error } = await supabase
      .from('ficha_medica')
      .insert([fichaData])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Crear registro financiero
app.post('/api/finanzas', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const finanzaData = { ...req.body, academia_id };

    const { data, error } = await supabase
      .from('finanzas')
      .insert([finanzaData])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Obtener categorías (para el frontend)
app.get('/api/categorias', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;

    const { data, error } = await supabase
      .from('config_categorias')
      .select('*')
      .eq('academia_id', academia_id)
      .order('edad_maxima', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
