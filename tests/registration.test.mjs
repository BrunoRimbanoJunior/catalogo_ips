import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Execute the actual submit handler with isolated UI and network dependencies.
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('  async function submitRegistration('), source.indexOf('  async function doSearch('));
function setup({ session = null, otpEmail = '', otpCode = '', verifyError = null, device = 'this-device', rpcError = null } = {}) {
  const calls = []; const state = {};
  const values = {
    supabase: {
      auth: {
        getSession: async () => ({ data: { session } }),
        signInWithOtp: async args => { calls.push(['send', args]); return {}; },
        verifyOtp: async args => { calls.push(['verify', args]); return { data: { session: { user: { id: 'user-a', email: 'a@example.com' } } }, error: verifyError }; },
      },
      rpc: async (name, args) => { calls.push(['rpc', name, args]); return { data: { id: 'profile-a', status: 'approved', device_authorized: device === 'this-device', device_count: 2 }, error: rpcError }; },
    },
    form: { full_name: 'Pessoa', email: 'a@example.com' }, registrationEmail: '',
    validateRegistrationForm: () => ({ email: 'a@example.com', cpfCnpj: '123' }),
    otpEmail, otpCode, fingerprint: 'this-device',
    applyProfileData: data => { state.profile = data; },
  };
  for (const key of ['AuthSuccess', 'AuthError', 'FormSubmitting', 'OtpEmail', 'OtpCode', 'RegistrationEmail', 'Form', 'SentOnce']) values['set' + key] = value => { state[key] = value; };
  const run = new Function(...Object.keys(values), handler + '\nreturn submitRegistration;')(...Object.values(values));
  return { run, calls, state };
}
test('new machine sends OTP before touching profiles', async () => {
  const t = setup(); await t.run();
  assert.deepEqual(t.calls.map(c => c[0]), ['send']);
  assert.equal(t.state.OtpEmail, 'a@example.com');
  assert.equal(t.state.FormSubmitting, false);
});
test('invalid code cannot save registration', async () => {
  const t = setup({ otpEmail: 'a@example.com', otpCode: 'wrong', verifyError: { message: 'Código inválido' } }); await t.run();
  assert.deepEqual(t.calls.map(c => c[0]), ['verify']);
  assert.match(t.state.AuthError, /Código inválido/);
});
test('verified code saves through server RPC', async () => {
  const t = setup({ otpEmail: 'a@example.com', otpCode: '123456' }); await t.run();
  assert.deepEqual(t.calls.map(c => c[0]), ['verify', 'rpc']);
  assert.equal(t.calls[1][1], 'register_catalog_profile');
  assert.equal(t.state.profile.id, 'profile-a');
});
test('unregistered device does not show success', async () => {
  const t = setup({ session: { user: { email: 'a@example.com' } }, device: 'old-device' }); await t.run();
  assert.match(t.state.AuthError, /dispositivo/);
  assert.equal(t.state.SentOnce, false);
});
test('server denial is not reported as success', async () => {
  const t = setup({ session: { user: { email: 'a@example.com' } }, rpcError: { message: 'permission denied' } }); await t.run();
  assert.match(t.state.AuthError, /permission denied/);
  assert.equal(t.state.profile, undefined);
  assert.equal(t.state.FormSubmitting, false);
});
test('changing email requires a new code', async () => {
  const t = setup({ session: { user: { email: 'b@example.com' } }, otpEmail: 'b@example.com', otpCode: '123456' }); await t.run();
  assert.deepEqual(t.calls.map(c => c[0]), ['send']);
});
