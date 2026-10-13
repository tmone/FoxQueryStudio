// tedious loads the Azure Active Directory client at start even when only SQL logins are used.
// The real package is 45 MB; this stand-in keeps the bundle small and fails clearly if ever reached.
const unsupported = () => {
  throw new Error('Đăng nhập Azure Active Directory không được hỗ trợ; dùng tài khoản SQL Server.');
};

export class ClientSecretCredential {
  constructor() {
    unsupported();
  }
}
export class DefaultAzureCredential extends ClientSecretCredential {}
export class ManagedIdentityCredential extends ClientSecretCredential {}
export class UsernamePasswordCredential extends ClientSecretCredential {}
