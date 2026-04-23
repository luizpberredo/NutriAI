// api/strava-callback.js
// Rota dedicada para o callback do Strava OAuth.
//
// O Strava só aceita um domínio no campo "Authorization Callback Domain"
// (ex: nutri-ai-lac.vercel.app), então o redirect_uri registrado no app
// deve ser:  https://nutri-ai-lac.vercel.app/api/strava-callback
//
// Esta função recebe o code+state do Strava e delega o processamento
// para api/oauth.js adicionando provider=strava&action=callback.

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  // Monta a URL interna do handler oauth com os params necessários
  const host = req.headers.host;
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const base = `${protocol}://${host}`;

  const target = new URL(`${base}/api/oauth`);
  target.searchParams.set('provider', 'strava');
  target.searchParams.set('action', 'callback');
  if (code)  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  if (error) target.searchParams.set('error', error);

  return res.redirect(302, target.toString());
}
