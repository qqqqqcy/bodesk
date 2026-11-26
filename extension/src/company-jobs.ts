export function isCompanyJobsPath(path: string) {
  return /^\/gongsi\/job\/[a-zA-Z0-9_~-]+\.html$/.test(path);
}
