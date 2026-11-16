import { Body, ConflictException, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { Public } from '../common/auth.js';
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

  private async tokens(userId: number) {
    return {
      accessToken: await this.jwt.signAsync({ sub: userId, typ: 'access' }, { expiresIn: '1h' }),
      refreshToken: await this.jwt.signAsync({ sub: userId, typ: 'refresh' }, { expiresIn: '30d' }),
    };
  }

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.users.findOneBy({ email })) throw new ConflictException('An account with this email already exists');
    const user = await this.users.save(
      this.users.create({ email, name: dto.name.trim(), passwordHash: await bcrypt.hash(dto.password, 10), settings: DEFAULT_SETTINGS }),
    );
    return this.tokens(user.id);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    const user = await this.users.findOneBy({ email: dto.email.toLowerCase().trim() });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException('Wrong email or password');
    return this.tokens(user.id);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto) {
    try {
      const p = await this.jwt.verifyAsync<{ sub: number; typ: string }>(dto.refreshToken);
      if (p.typ !== 'refresh' || !(await this.users.existsBy({ id: p.sub }))) throw new Error();
      return this.tokens(p.sub);
    } catch {
      throw new UnauthorizedException('Please log in again');
    }
  }
}
