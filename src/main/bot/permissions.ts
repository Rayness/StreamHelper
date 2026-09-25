import type { ChatRoles, Permission } from '@shared/types';

const RANK: Record<Permission, number> = { everyone: 0, subscriber: 1, vip: 2, moderator: 3, broadcaster: 4 };

export function userRank(roles: ChatRoles): number {
  if (roles.broadcaster) return RANK.broadcaster;
  if (roles.moderator) return RANK.moderator;
  if (roles.vip) return RANK.vip;
  if (roles.subscriber) return RANK.subscriber;
  return RANK.everyone;
}

export function hasPermission(roles: ChatRoles, required: Permission): boolean {
  return userRank(roles) >= RANK[required];
}
