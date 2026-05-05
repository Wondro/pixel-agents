const APP_ZONE_ASSIGNMENT_PREFIX = 'app:';

export function getAppZoneAssignmentKey(appName: string | undefined | null): string | null {
  const cleanName = appName?.trim();
  return cleanName ? `${APP_ZONE_ASSIGNMENT_PREFIX}${cleanName}` : null;
}

export function isAppZoneAssignmentKey(key: string): boolean {
  return (
    key.startsWith(APP_ZONE_ASSIGNMENT_PREFIX) && key.length > APP_ZONE_ASSIGNMENT_PREFIX.length
  );
}

export function getAppNameFromZoneAssignmentKey(key: string): string {
  return isAppZoneAssignmentKey(key) ? key.slice(APP_ZONE_ASSIGNMENT_PREFIX.length) : key;
}
