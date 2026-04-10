import React, { createContext, useContext, useEffect, useState } from "react";
import { songCatalogService } from "../services/SongCatalogService";

interface CatalogContextValue {
  isCatalogReady: boolean;
}

const CatalogContext = createContext<CatalogContextValue | null>(null);

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const [isCatalogReady, setIsReady] = useState(false);

  useEffect(() => {
    songCatalogService.initialize().finally(() => setIsReady(true));
  }, []);

  return <CatalogContext.Provider value={{ isCatalogReady: isCatalogReady }}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("useCatalog must be used within a CatalogProvider");
  return ctx;
}
