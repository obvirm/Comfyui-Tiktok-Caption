// Mounts the REAL tscaps template gallery (TemplateSelector) into the node's
// right sidebar via React. The gallery is vendored from tscaps
// (vendor/tscaps-ui) and rendered against the same engine the final renderer
// uses, so the cards look and behave 1:1 with the tscaps editor.
//
// Build context: this file is bundled by `npm run build` (esbuild) with the
// @ui/@core/@presentation/@styles/@tscaps/engine/@modules aliases defined in
// package.json. TypeScript types from tscaps are erased at bundle time.
import { createRoot, type Root } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { EngineProvider } from '@ui/_shared/contexts/modules/EngineContext';
import { TemplatePreviewArtifactsProvider } from '@ui/pages/editor/contexts/TemplatePreviewArtifactsContext';
import { TemplateSelector } from '@ui/pages/editor/components/template/TemplateSelector';
import { TemplatePreviewArtifactsBuilder } from '@presentation/editor/services/TemplatePreviewArtifactsBuilder';
import { TypographyCssVarBuilder } from '@core/sheets/services/TypographyCssVarBuilder';
import { RotationCssVarBuilder } from '@core/sheets/services/RotationCssVarBuilder';
import { StyleValuesCssVarsBuilder } from '@core/sheets/services/StyleValuesCssVarsBuilder';
import { Template } from '@core/templates/domain/Template';
import { SvgFilterDefinitions, GraphemeWordSplitter } from '@tscaps/engine';
import { TYPOGRAPHY_DEFAULTS } from '@core/sheets/domain/TypographyConfig';
import { ROTATION_DEFAULTS } from '@core/sheets/domain/RotationConfig';

const TEMPLATES_BASE = '/extensions/Comfyui-Caption-Live/templates';

// Mirrors tscaps's LocalFileTemplateLoader defaults for the fields the preview
// actually reads (typography / rotation / alignment / rendering / style vars).
const ALIGNMENT_DEFAULT = { verticalAlign: 'top', verticalOffset: 0.75, horizontalAlign: 'center', horizontalOffset: 0.5 };

// The preview only needs these template fields; effect/splitter configs are
// unused by the static/animated preview, so we pass inert dummies.
function buildTemplate(name: string, data: any, css: string): Template {
  const typography = { ...TYPOGRAPHY_DEFAULTS, ...(data?.typography || {}) };
  const rotation = { ...ROTATION_DEFAULTS, ...(data?.rotation || {}) };
  const alignment = { ...ALIGNMENT_DEFAULT, ...(data?.alignment || {}) };
  const rendering = {
    splitWordsIntoLetters: data?.rendering?.splitWordsIntoLetters ?? false,
    videoFrame: { required: false, jpegQuality: 0.7, previewMode: 'omit' as const, ...(data?.rendering?.videoFrame || {}) },
    padding: null,
  };
  const features = {
    rotation: {
      segment: data?.features?.rotation?.segment ?? true,
      word: data?.features?.rotation?.word ?? true,
    },
  };
  const metadata = {
    id: name,
    name: data?.name || name,
    categories: data?.categories || [],
    unsupportedUserAgents: data?.unsupportedUserAgents || [],
  };
  return new Template(
    metadata as any,
    typography as any,
    rotation as any,
    alignment as any,
    rendering as any,
    features as any,
    [],
    [],
    { type: data?.lineSplitter?.type || 'balanced' } as any,
    data?.styleControls || [],
    data?.variants || [],
    SvgFilterDefinitions.empty(),
    css,
    '',
  );
}

export function mountTemplateSidebar(
  container: HTMLElement,
  opts: { names: string[]; getSelected: () => string | null; onSelect: (name: string) => void },
): { dispose: () => void } {
  // Inject the compiled tscaps UI stylesheet once per page.
  if (!document.getElementById('tscaps-ui-css')) {
    const link = document.createElement('link');
    link.id = 'tscaps-ui-css';
    link.rel = 'stylesheet';
    link.href = '/extensions/Comfyui-Caption-Live/css/tscaps-ui.css';
    document.head.appendChild(link);
  }

  const engine = { wordSplitter: new GraphemeWordSplitter() };
  const assetRepo = {
    list: () => [],
    resolve: (id: string) => (id ? { url: `/extensions/Comfyui-Caption-Live/templates/_assets/${id}.png` } : null),
  };
  const artifactsBuilder = new TemplatePreviewArtifactsBuilder(
    new TypographyCssVarBuilder(),
    new RotationCssVarBuilder(),
    new StyleValuesCssVarsBuilder(assetRepo as any),
  );
  // (The vendored CssAssetReferenceResolver inside TemplatePreviewArtifactsBuilder
  // now resolves `asset:<id>` to our served _assets path instead of null.)
  const library = { favorites: new Set<string>(), toggleFavorite: () => {} };

  const Gallery = () => {
    const [templates, setTemplates] = useState<Template[]>([]);
    const [selected, setSelected] = useState<string | null>(opts.getSelected());

    useEffect(() => {
      let alive = true;
      (async () => {
        const loaded: Template[] = [];
        for (const name of opts.names) {
          try {
            const [cssTxt, jsonTxt] = await Promise.all([
              fetch(`${TEMPLATES_BASE}/${encodeURIComponent(name)}/style.css`).then((r) => r.text()),
              fetch(`${TEMPLATES_BASE}/${encodeURIComponent(name)}/template.json`).then((r) => r.text()),
            ]);
            // Rewrite `asset:<id>` template refs to the served _assets URL
            // BEFORE handing the CSS to the vendored gallery — its
            // buildScopedCss does NOT run CssAssetReferenceResolver, so a raw
            // token would leak into the DOM (browser → CORS error on the
            // `asset:` scheme). .png is appended (our pool holds PNGs).
            const resolvedCss = (cssTxt || '').replace(
              /asset:([a-zA-Z0-9_-]+)/g,
              (_m, id) => `${TEMPLATES_BASE}/_assets/${id}.png`,
            );
            loaded.push(buildTemplate(name, JSON.parse(jsonTxt), resolvedCss));
          } catch (e) {
            console.warn('[tscaps gallery] failed to load', name, e);
          }
        }
        if (alive) setTemplates(loaded);
      })();
      return () => { alive = false; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opts.names.join(',')]);

    const selectedTemplate = templates.find((t) => t.metadata.id === selected) || null;

    return (
      <TemplateSelector
        templates={templates}
        userTemplates={[]}
        selectedTemplate={selectedTemplate}
        onSelect={(t: Template) => { setSelected(t.metadata.id); opts.onSelect(t.metadata.id); }}
        onDeleteUserTemplate={() => {}}
        onRenameUserTemplate={() => {}}
        library={library as any}
      />
    );
  };

  const root: Root = createRoot(container);
  root.render(
    <EngineProvider value={engine as any}>
      <TemplatePreviewArtifactsProvider value={artifactsBuilder}>
        <Gallery />
      </TemplatePreviewArtifactsProvider>
    </EngineProvider>,
  );

  return { dispose: () => root.unmount() };
}
