import { Body, ConflictException, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { Public, tokenClaims, TokenPayload, tokenUserValid } from '../common/auth.js';
import { DEFAULT_SETTINGS, User } from '../common/entities.js';

class RegisterDto {
  @IsString() @IsNotEmpty() name: string;
  @IsEmail() email: string;
  @IsString() @MinLength(6) password: string;
}

class LoginDto {
  @IsEmail() email: string;
  @IsString() password: string;
}

class RefreshDto {
  @IsString() refreshToken: string;
}

@Public()
@Controller('v1/auth')
export class AuthController {
  constructor(@InjectRepository(User) private users: Repository<User>, private jwt: JwtService) {}

  private async tokens(user: User) {
    return {
      accessToken: await this.jwt.signAsync(tokenClaims(user, 'access'), { expiresIn: '1h' }),
      refreshToken: await this.jwt.signAsync(tokenClaims(user, 'refresh'), { expiresIn: '30d' }),
    };
  }

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.users.findOneBy({ email })) throw new ConflictException('An account with this email already exists');
    const user = await this.users.save(
      this.users.create({ email, name: dto.name.trim(), passwordHash: await bcrypt.hash(dto.password, 10), settings: DEFAULT_SETTINGS }),
    );
    return this.tokens(user);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    const user = await this.users.findOneBy({ email: dto.email.toLowerCase().trim() });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException('Wrong email or password');
    return this.tokens(user);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto) {
    try {
      const p = await this.jwt.verifyAsync<TokenPayload>(dto.refreshToken);
      if (p.typ !== 'refresh' || !(await tokenUserValid(this.users, p))) throw new Error();
      return this.tokens((await this.users.findOneBy({ id: p.sub }))!);
    } catch {
      throw new UnauthorizedException('Please log in again');
    }
  }
}
