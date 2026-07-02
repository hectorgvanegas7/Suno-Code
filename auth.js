const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');
const http = require('http');
const url = require('url');

const CRED_PATH = 'oauth-credentials.json';
const TOKEN_PATH = 'token.json';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

async function main() {
  const credentials = JSON.parse(fs.readFileSync(CRED_PATH, 'utf-8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  
  // Use http://localhost:3000 as redirect URL for ease of use
  const redirectUri = 'http://localhost:3000';
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n======================================================');
  console.log('🔗 AUTORIZACIÓN DE GOOGLE REQUERIDA');
  console.log('======================================================');
  console.log('Por favor haz clic en el siguiente enlace y autoriza el acceso:');
  console.log(`\n${authUrl}\n`);
  console.log('======================================================\n');
  console.log('⏳ Esperando la respuesta en el navegador...\n');

  const server = http.createServer(async (req, res) => {
    const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
    const code = qs.get('code');
    if (code) {
      res.end('<h1>Autorizacion completada con exito!</h1><p>Ya puedes cerrar esta ventana y volver a la terminal.</p>');
      server.close();
      console.log('✅ Código recibido. Generando token...');
      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log(`🎉 ¡Token guardado exitosamente en ${TOKEN_PATH}!`);
        console.log('El script ya tiene permiso permanente para actuar en tu nombre.');
        process.exit(0);
      } catch (err) {
        console.error('❌ Error al obtener el token:', err);
        process.exit(1);
      }
    } else {
      res.end('No code found in URL');
    }
  }).listen(3000);
}

main().catch(console.error);
