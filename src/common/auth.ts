import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities.js';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface TokenPayload { sub: number; typ: 'access' | 'refresh'; ca: number }

/**
 * Tokens name the account by id and by when it was created. Ids restart when the database is reset,
 * so the id alone could point an old token at someone else's new account.
 */
export function tokenClaims(user: Pick<User, 'id' | 'createdAt'>, typ: TokenPayload['typ']): TokenPayload {
  return { sub: user.id, typ, ca: new Date(user.createdAt).getTime() };
}

/** True when the token's account still exists and is the same account it was issued for. */
export async function tokenUserValid(users: Repository<User>, p: TokenPayload): Promise<boolean> {
  if (typeof p.sub !== 'number' || typeof p.ca !== 'number') return false;
  const u = await users.findOne({ where: { id: p.sub }, select: { id: true, createdAt: true } });
  return !!u && new Date(u.createdAt).getTime() === p.ca;
}

/** Injects the signed-in user's id. */
export const UserId = createParamDecorator((_: unknown, ctx: ExecutionContext): number => {
  return ctx.switchToHttp().getRequest().userId;
});

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync<TokenPayload>(token);
      if (payload.typ !== 'access') throw new Error('wrong token type');
      // Deleted account, or a token from before a database reset: make the app sign in again.
      if (!(await tokenUserValid(this.users, payload))) throw new Error('account gone');
      req.userId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
