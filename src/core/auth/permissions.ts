import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  type Permission,
  type Role,
} from "../../config/constants";
import { RoleModel } from "./roleModel";

export async function resolveUserPermissions(
  role: Role | string,
  companyId?: string,
  customRoleId?: string,
): Promise<Permission[]> {
  if (role === "super_admin") {
    return [...PERMISSIONS];
  }

  // System roles default permission mapping
  if (role in ROLE_DEFAULT_PERMISSIONS) {
    return [...ROLE_DEFAULT_PERMISSIONS[role as Role]];
  }

  // Custom tenant-defined role lookup
  if (companyId && customRoleId) {
    const customRole = await RoleModel.findById(customRoleId).setOptions({ skipTenant: false }).lean();
    if (customRole && Array.isArray(customRole.permissions)) {
      return customRole.permissions as Permission[];
    }
  }

  return [];
}

export function hasPermission(
  userPermissions: string[],
  requiredPermission: Permission | Permission[],
): boolean {
  if (userPermissions.includes("*")) return true;

  const required = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
  return required.some((perm) => {
    if (userPermissions.includes(perm)) return true;
    const [domain] = perm.split(".");
    return userPermissions.includes(`${domain}.*`);
  });
}
