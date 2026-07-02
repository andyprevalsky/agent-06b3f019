import jwt from 'jsonwebtoken';

export const decodeJwt = jwt.decode;
export const verifyJwt = jwt.verify;
