export interface CompanyRegistrationFields {
  name: string;
  legalPerson: string;
  registeredCapital: string;
  status: string;
  establishDate: string;
  unifiedCode: string;
  address: string;
  businessScope: string;
  paidInCapital?: string;
  enterpriseType?: string;
  registrationAuthority?: string;
}

export interface CompanyShareholderFields {
  name: string;
  ratio?: string;
  shares?: string;
}

export function pickQichachaResult(data: any): any {
  const result = data?.Result ?? data?.result ?? data?.Data ?? data?.data;
  if (Array.isArray(result)) return result[0];
  if (Array.isArray(result?.Result)) return result.Result[0];
  if (Array.isArray(result?.Items)) return result.Items[0];
  if (Array.isArray(result?.items)) return result.items[0];
  return result || data;
}

function firstCompanyString(raw: Record<string, any>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function suppliedCompanyString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Projects supplied direct-shareholder fields without changing their units or precision. */
export function mapQichachaShareholders(raw: unknown): CompanyShareholderFields[] {
  const record = pickQichachaResult(raw);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  // i18n-allow: official provider JSON property names, not display copy.
  const entries = record['股东信息'] ?? record.Shareholders ?? record.shareholders ?? record.Partners;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const supplied = entry as Record<string, unknown>;
    // i18n-allow: official provider JSON property names, not display copy.
    const name = firstCompanyString(supplied, ['股东名称', 'Name', 'name', 'StockName']);
    if (!name) return [];
    // i18n-allow: official provider JSON property names, not display copy.
    const ratio = suppliedCompanyString(supplied['持股比例'] ?? supplied.Ratio ?? supplied.ratio ?? supplied.StockPercent);
    // i18n-allow: official provider JSON property names, not display copy.
    const shares = suppliedCompanyString(supplied['持股数'] ?? supplied.Shares ?? supplied.shares ?? supplied.StockCount);
    return [{ name, ...(ratio !== undefined ? { ratio } : {}), ...(shares !== undefined ? { shares } : {}) }];
  });
}

/** Projects a registration object only; source selection and provenance remain with the caller. */
export function mapQichachaCompanyRegistration(raw: unknown): CompanyRegistrationFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, any>;
  const name = firstCompanyString(record, ['企业名称', 'Name', 'name', 'CompanyName', 'companyName']); // i18n-allow: official provider JSON property names, not display copy.
  if (!name) return null;
  const paidInCapital = suppliedCompanyString(record['实缴资本']); // i18n-allow: actual official provider JSON property.
  const enterpriseType = suppliedCompanyString(record['企业类型']); // i18n-allow: actual official provider JSON property.
  const registrationAuthority = suppliedCompanyString(record['登记机关']); // i18n-allow: actual official provider JSON property.
  return {
    name,
    legalPerson: record['法定代表人'] || record.OperName || record.legalPersonName || record.LegalPerson || record.operName || '', // i18n-allow: existing provider JSON property names.
    registeredCapital: record['注册资本'] || record.RegistCapi || record.registeredCapital || record.RegisteredCapital || '', // i18n-allow: existing provider JSON property names.
    status: record['登记状态'] || record.Status || record.regStatus || record.StatusCode || record.status || '', // i18n-allow: existing provider JSON property names.
    establishDate: record['成立日期'] || record.StartDate || record.establishDate || record.EstablishDate || '', // i18n-allow: existing provider JSON property names.
    unifiedCode: record['统一社会信用代码'] || record.CreditCode || record.unifiedCode || record.CreditNo || record.No || '', // i18n-allow: existing provider JSON property names.
    address: record['注册地址'] || record.Address || record.address || '', // i18n-allow: existing provider JSON property names.
    businessScope: record['经营范围'] || record.Scope || record.businessScope || record.BusinessScope || '', // i18n-allow: existing provider JSON property names.
    ...(paidInCapital !== undefined ? { paidInCapital } : {}),
    ...(enterpriseType !== undefined ? { enterpriseType } : {}),
    ...(registrationAuthority !== undefined ? { registrationAuthority } : {}),
  };
}
