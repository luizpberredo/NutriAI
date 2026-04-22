export default function handler(req, res) {
  const clientId = process.env.WITHINGS_CLIENT_ID;
  const host = req.headers.host;
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth-withings-callback`;

  const url = new URL('https://account.withings.com/oauth2_user/authorize2');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'user.metrics');
  url.searchParams.set('state', 'nutriai');

  res.redirect(302, url.toString());
}
