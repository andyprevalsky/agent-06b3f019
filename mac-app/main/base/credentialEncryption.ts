/**
 * Shared credential encryption constants for local credential sync domains.
 */

/**
 * RSA-2048 Public Key used to encrypt local credentials before upload.
 * The corresponding private key lives on the backend as
 * `CLAUDE_CREDENTIAL_DECRYPTION_KEY`.
 */
export const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyb0JJxUJ5Xb/agJKydem
vW7TwQiSMb2JWxNhErFx6BmKrLV/ISXVV/upVnb+P81ALRBNEvbtT+E20URnAv3H
nOjaHB/ZZRccfn6G9sQ/TtGcj/BD/PAOtmAC19CsZeHBCwExxuGnHh6K2mcUK40B
55jYGV0oJF8njalwEAUwWWu6H5Trs2OwvN06D+SrycccmMaAMkKQxgPsQEE+9bIT
uU2H4vZYBbnfXJJJw7pCCA7Tu1SfkFh8R+cp+gBL3G9xQPFtukwM2qFrpLBZP/qt
se+GalFwrA45LYFLKaLMdAUOy6Z+6Td/5sbhAT/3LPFnll1cSRwh8MlF/xeskYsr
kwIDAQAB
-----END PUBLIC KEY-----`;
