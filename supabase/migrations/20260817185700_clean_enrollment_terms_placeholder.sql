-- El editor histórico de Términos cargaba esta frase como contenido real cuando
-- aún no había configuración. Si luego el director escribía debajo, la frase
-- quedaba persistida junto con los términos. Se elimina únicamente ese prefijo
-- generado por Syncademia, conservando cualquier contenido escrito después.

do $$
declare
  placeholder constant text := 'Aún no se han establecido los términos y condiciones de la academia.';
begin
  update public.academias
     set terminos_condiciones = null
   where btrim(coalesce(terminos_condiciones, '')) = placeholder;

  update public.academias
     set terminos_condiciones = nullif(btrim(substr(terminos_condiciones, length(placeholder) + 1)), '')
   where terminos_condiciones like placeholder || '%'
     and btrim(terminos_condiciones) <> placeholder;
end;
$$;
