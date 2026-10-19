/* Link-based login. Passwords are generated with high entropy; only salted digests are stored. */
var AUTH_USERS_KEY = 'LEDGER_USERS_V1';
var AUTH_SESSION_SECONDS = 21600;

function authHex_(bytes) {
  return bytes.map(function (byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
}
function authHash_(salt, password) {
  return authHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    salt + '\u0000' + password, Utilities.Charset.UTF_8));
}
function authEqual_(left, right) {
  if (left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
function authUsers_() {
  var props = PropertiesService.getScriptProperties();
  var saved = props.getProperty(AUTH_USERS_KEY);
  if (!saved) {
    var initial = AUTH_SEED_USERS.map(function (user) { return Object.assign({ version: 1 }, user); });
    if (!initial.length) {
      var ownerPassword = props.getProperty('BOOTSTRAP_OWNER_PASSWORD');
      var managerPassword = props.getProperty('BOOTSTRAP_MANAGER_PASSWORD');
      if (!ownerPassword || !managerPassword) throw new Error('尚未設定初始帳號；請先依 README 設定 Script Properties');
      initial = [
        { username: 'owner', label: '主管理人', role: 'OWNER', enabled: true, version: 0 },
        { username: 'coadmin', label: '共同管理人', role: 'MANAGER', enabled: true, version: 0 }
      ];
      authSetPassword_(initial[0], ownerPassword);
      authSetPassword_(initial[1], managerPassword);
    }
    props.setProperty(AUTH_USERS_KEY, JSON.stringify(initial));
    props.deleteProperty('BOOTSTRAP_OWNER_PASSWORD');
    props.deleteProperty('BOOTSTRAP_MANAGER_PASSWORD');
    return initial;
  }
  return JSON.parse(saved);
}
function authSaveUsers_(users) {
  PropertiesService.getScriptProperties().setProperty(AUTH_USERS_KEY, JSON.stringify(users));
}
function authSessionKey_(token) {
  return 's:' + authHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token)));
}
function authPublicUser_(user) {
  return { username: user.username, label: user.label, role: user.role, enabled: user.enabled };
}
function auth_(token, requiredRole) {
  if (typeof token !== 'string' || token.length < 50 || token.length > 150) throw new Error('請先登入');
  var stored = CacheService.getScriptCache().get(authSessionKey_(token));
  if (!stored) throw new Error('登入已到期，請重新登入');
  var session = JSON.parse(stored);
  var user = authUsers_().find(function (item) { return item.username === session.username; });
  if (!user || !user.enabled || user.version !== session.version) throw new Error('登入已失效，請重新登入');
  if (requiredRole === 'OWNER' && user.role !== 'OWNER') throw new Error('此操作僅限主管理人');
  return user;
}
function login(username, password) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  if (!/^[a-z0-9_-]{3,32}$/.test(username) || password.length > 128) throw new Error('帳號或密碼錯誤');
  var cache = CacheService.getScriptCache();
  var attemptKey = 'a:' + username;
  var attempts = Number(cache.get(attemptKey) || 0);
  if (attempts >= 8) throw new Error('登入嘗試過多，請 15 分鐘後再試');
  var user = authUsers_().find(function (item) { return item.username === username && item.enabled; });
  var digest = authHash_(user ? user.salt : 'invalid-user', password);
  if (!user || !authEqual_(digest, user.hash)) {
    cache.put(attemptKey, String(attempts + 1), 900);
    throw new Error('帳號或密碼錯誤');
  }
  cache.remove(attemptKey);
  var token = Utilities.getUuid() + Utilities.getUuid();
  cache.put(authSessionKey_(token), JSON.stringify({ username: user.username, version: user.version }), AUTH_SESSION_SECONDS);
  return { token: token, user: authPublicUser_(user), expiresInSeconds: AUTH_SESSION_SECONDS };
}
function logout(token) {
  if (typeof token === 'string' && token.length >= 50 && token.length <= 150) {
    CacheService.getScriptCache().remove(authSessionKey_(token));
  }
  return { signedOut: true };
}
function getSessionInfo(token) { return authPublicUser_(auth_(token)); }
function listUsers(token) {
  auth_(token, 'OWNER');
  return authUsers_().map(authPublicUser_);
}
function authSetPassword_(user, password) {
  password = String(password || '');
  if (password.length < 16 || password.length > 128) throw new Error('密碼須為 16 至 128 個字元');
  user.salt = Utilities.getUuid().replace(/-/g, '');
  user.hash = authHash_(user.salt, password);
  user.version = (user.version || 0) + 1;
}
function changePassword(token, currentPassword, newPassword) {
  var me = auth_(token);
  if (!authEqual_(authHash_(me.salt, String(currentPassword || '')), me.hash)) throw new Error('目前密碼不正確');
  var users = authUsers_();
  var target = users.find(function (user) { return user.username === me.username; });
  authSetPassword_(target, newPassword);
  authSaveUsers_(users);
  logout(token);
  return { changed: true };
}
function setUserPassword(token, username, newPassword) {
  auth_(token, 'OWNER');
  var users = authUsers_();
  var target = users.find(function (user) { return user.username === username; });
  if (!target) throw new Error('找不到帳號');
  authSetPassword_(target, newPassword);
  authSaveUsers_(users);
  return { changed: true };
}
function setUserEnabled(token, username, enabled) {
  auth_(token, 'OWNER');
  var users = authUsers_();
  var target = users.find(function (user) { return user.username === username; });
  if (!target || target.role === 'OWNER') throw new Error('只能停用或啟用共同管理人');
  target.enabled = enabled === true;
  target.version = (target.version || 0) + 1;
  authSaveUsers_(users);
  return authPublicUser_(target);
}
