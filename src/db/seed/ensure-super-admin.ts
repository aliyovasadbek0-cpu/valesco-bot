import bcrypt from 'bcrypt';
import { DEFAULT_SUPER_ADMIN } from '../../config/seed/super-admin';
import { UserModel, UserRole, UserStatus } from '../models/users.model';

const SALT_ROUNDS = 10;

export async function ensureSuperAdmin() {
  if (!DEFAULT_SUPER_ADMIN.username || !DEFAULT_SUPER_ADMIN.password) {
    console.warn('[seed] DEFAULT_SUPER_ADMIN username/password is missing. Skipping seed.');
    return;
  }

  const existing = await UserModel.findOne({
    username: DEFAULT_SUPER_ADMIN.username,
    role: UserRole.SUPER_ADMIN,
    deletedAt: null,
  }).lean();

  if (existing) {
    console.log('[seed] Super admin already exists. Skipping creation.');
    return;
  }

  const passwordHash = await bcrypt.hash(DEFAULT_SUPER_ADMIN.password, SALT_ROUNDS);

  await UserModel.create({
    username: DEFAULT_SUPER_ADMIN.username,
    password: passwordHash,
    firstName: DEFAULT_SUPER_ADMIN.firstName,
    lastName: DEFAULT_SUPER_ADMIN.lastName ?? '',
    tgId: DEFAULT_SUPER_ADMIN.tgId,
    tgFirstName: DEFAULT_SUPER_ADMIN.tgFirstName,
    tgLastName: DEFAULT_SUPER_ADMIN.tgLastName ?? '',
    tgUsername: DEFAULT_SUPER_ADMIN.tgUsername ?? DEFAULT_SUPER_ADMIN.username,
    phoneNumber: DEFAULT_SUPER_ADMIN.phoneNumber ?? '',
    lang: DEFAULT_SUPER_ADMIN.lang ?? 'uz',
    status: UserStatus.ACTIVE,
    role: UserRole.SUPER_ADMIN,
  });

  console.log('[seed] Default super admin user created.');
}

