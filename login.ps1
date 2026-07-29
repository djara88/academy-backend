# Crear el archivo login.ps1
$body = @{
    email = "d.jarazerene@gmail.com"
    password = "Inicio18."
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:8080/api/login" -Method POST -ContentType "application/json" -Body $body

# Mostrar el token
Write-Host "Token: $($response.token)"