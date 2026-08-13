import variantMetadata from '../.lumi/variant.json';

export interface ProductVariantRuntime {
  productName: string;
  desktopTitle: string;
  appIdentifier: string;
  mobileAppIdentifier: string;
  dataDirectoryName: string;
  updaterChannel: string;
  defaultSkills: string[];
  modules: string[];
}

export interface ProductVariant {
  schemaVersion: number;
  variantId: string;
  displayName: string;
  productLine: string;
  runtime: ProductVariantRuntime;
}

const raw = variantMetadata as ProductVariant;

export const PRODUCT_VARIANT: Readonly<ProductVariant> = Object.freeze({
  ...raw,
  runtime: Object.freeze({
    ...raw.runtime,
    defaultSkills: [...raw.runtime.defaultSkills],
    modules: [...raw.runtime.modules],
  }),
});

export function hasProductModule(moduleId: string): boolean {
  return PRODUCT_VARIANT.runtime.modules.includes(String(moduleId || '').trim());
}
