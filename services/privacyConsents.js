const PRIVACY_VERSION = '2026.1';

const CONSENT_DEFINITIONS = {
  aviso_privacidad: {
    obligatorio: true,
    titulo: 'Aviso de privacidad y tratamiento operativo',
    finalidad: 'Gestionar la matrícula, administración deportiva, comunicaciones operativas, asistencia, categorías, cobros y soporte de la relación con la academia.',
    contenido: 'Declaro haber recibido y comprendido el aviso de privacidad de la academia. Se me informa que los datos personales necesarios para la gestión deportiva y administrativa serán tratados únicamente para las finalidades informadas, con acceso limitado a personal autorizado y durante el tiempo necesario para prestar el servicio y cumplir obligaciones aplicables. Puedo solicitar acceso, rectificación, supresión u oposición cuando corresponda, utilizando los canales oficiales de la academia.'
  },
  datos_salud: {
    obligatorio: false,
    titulo: 'Información mínima de emergencia',
    finalidad: 'Registrar únicamente antecedentes mínimos entregados voluntariamente por el apoderado para apoyar una respuesta segura ante una emergencia durante la actividad deportiva.',
    contenido: 'Autorizo expresamente el registro de la información mínima de emergencia que entregue respecto del alumno para finalidades de seguridad y respuesta ante una contingencia vinculada a su participación deportiva. Comprendo que esta autorización no habilita a la academia ni a la plataforma para mantener una historia clínica, diagnósticos extensos ni antecedentes de salud que no sean estrictamente necesarios. Puedo solicitar su actualización o revocación para usos futuros, sin perjuicio de obligaciones legales aplicables.'
  },
  imagen_interna: {
    obligatorio: false,
    titulo: 'Uso interno de fotografía',
    finalidad: 'Utilizar la fotografía del alumno dentro de la plataforma y procesos internos de identificación y gestión deportiva de la academia.',
    contenido: 'Autorizo el uso de la fotografía del alumno exclusivamente para identificación interna, ficha deportiva, controles operativos e informes privados de la academia. Esta autorización no permite por sí sola publicar la imagen en redes sociales, sitios web, publicidad ni material promocional.'
  },
  imagen_publica: {
    obligatorio: false,
    titulo: 'Difusión pública de imagen',
    finalidad: 'Permitir a la academia publicar fotografías o material audiovisual del alumno en canales institucionales, redes sociales o piezas de difusión deportiva.',
    contenido: 'Autorizo de forma específica y separada la captación y publicación de fotografías o material audiovisual del alumno en los canales institucionales de la academia, incluyendo sitio web y redes sociales, con fines informativos, deportivos y de difusión institucional. Esta autorización es voluntaria, no condiciona la matrícula y puede ser revocada para usos futuros mediante los canales oficiales de la academia.'
  }
};

const getConsentCatalog = (academyName = 'la academia') => ({
  version: PRIVACY_VERSION,
  academy_name: academyName,
  items: Object.entries(CONSENT_DEFINITIONS).map(([tipo, value]) => ({ tipo, ...value }))
});

module.exports = { PRIVACY_VERSION, CONSENT_DEFINITIONS, getConsentCatalog };
