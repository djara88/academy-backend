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
    titulo: 'Autorización para datos de salud y emergencia',
    finalidad: 'Gestionar información mínima de salud y contacto de emergencia necesaria para responder ante situaciones deportivas o de seguridad del alumno.',
    contenido: 'Autorizo expresamente el tratamiento de la información de salud y emergencia que entregue respecto del alumno, exclusivamente para finalidades de seguridad, prevención y respuesta ante emergencias vinculadas a su participación deportiva. Comprendo que esta información es sensible, que debe limitarse a lo estrictamente necesario y que podré solicitar su actualización o revocación, sin perjuicio de tratamientos que deban mantenerse por obligación legal.'
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
