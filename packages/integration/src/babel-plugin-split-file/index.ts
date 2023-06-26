import type { PluginObj, PluginPass } from '@babel/core';
import { ContentGraph } from '@parcel/graph';
import { types as t } from '@babel/core';
import type { NodePath, Visitor } from '@babel/traverse';
import invariant from 'assert';
import { DefaultMap } from './DefaultMap';

type Graph = any;
type NodeId = number;

const declarationVisitor: Visitor<{
  graph: Graph;
  rootNode: number;
  declaredNodeIds: Array<NodeId>;
  statementNodeId: NodeId;
}> = {
  ImportSpecifier(path) {
    const importNodeId = this.graph.addNodeByContentKey(path.node.local.name, {
      type: 'import',
      local: path.node.local.name,
    });

    this.declaredNodeIds.push(importNodeId);
    this.graph.addEdge(this.statementNodeId, importNodeId);
  },
  ImportDefaultSpecifier(path) {
    const importNodeId = this.graph.addNodeByContentKey(path.node.local.name, {
      type: 'import',
      local: path.node.local.name,
    });

    this.declaredNodeIds.push(importNodeId);
    this.graph.addEdge(this.statementNodeId, importNodeId);
  },
  ImportNamespaceSpecifier(path) {
    const importNodeId = this.graph.addNodeByContentKey(path.node.local.name, {
      type: 'import',
      local: path.node.local.name,
    });

    this.declaredNodeIds.push(importNodeId);
    this.graph.addEdge(this.statementNodeId, importNodeId);
  },
  VariableDeclarator(path) {
    const names: Array<string> = [];

    const { node } = path;
    if (t.isIdentifier(node.id)) {
      names.push(node.id.name);
    } else {
      path.get('id').traverse({
        Identifier({ node }) {
          names.push(node.name);
        },
      });
    }

    for (const local of names) {
      const identNodeId = this.graph.addNodeByContentKey(local, {
        type: 'identifier',
        local,
      });

      this.declaredNodeIds.push(identNodeId);
      this.graph.addEdge(this.statementNodeId, identNodeId);
    }
    path.stop();
  },
  FunctionDeclaration(path) {
    if (path.node.id) {
      const identNodeId = this.graph.addNodeByContentKey(path.node.id.name, {
        type: 'identifier',
        local: path.node.id.name,
      });

      this.declaredNodeIds.push(identNodeId);
      this.graph.addEdge(this.statementNodeId, identNodeId);
    }
    path.stop();
  },
  ClassDeclaration(path) {
    const identNodeId = this.graph.addNodeByContentKey(path.node.id.name, {
      type: 'identifier',
      local: path.node.id.name,
    });

    this.declaredNodeIds.push(identNodeId);
    this.graph.addEdge(this.statementNodeId, identNodeId);
    path.stop();
  },
};

const referenceVisitor: Visitor<{
  graph: Graph;
  parentNodeIds: Array<NodeId>;
  macros: Array<string>;
  activeMacros: Array<NodeId>;
  macroRootNode: NodeId;
  statementNodeId: NodeId;
}> = {
  Identifier(path) {
    const { name } = path.node;

    if (this.graph.hasContentKey(name)) {
      const identNodeId = this.graph.getNodeIdByContentKey(name);

      for (const parentNodeId of this.parentNodeIds) {
        this.graph.addEdge(parentNodeId, identNodeId);
      }

      if (this.activeMacros.length > 0) {
        this.graph.addEdge(this.activeMacros.at(-1), identNodeId);
      }
    }
  },
  CallExpression: {
    enter(path) {
      const { callee, loc } = path.node;

      if (
        t.isIdentifier(callee) &&
        this.macros.some((m) => m === callee.name)
      ) {
        const macroContentKey = `${callee.name}-${loc?.start.line}-${loc?.start.column}`;
        const macroNodeId = this.graph.addNodeByContentKey(macroContentKey, {
          type: 'macro',
          name: callee.name,
          ast: path.node,
          injectedIndentifier: `__VE_${macroContentKey}`,
        });
        this.graph.addEdge(this.macroRootNode, macroNodeId);
        this.graph.addEdge(this.statementNodeId, macroNodeId);
        this.activeMacros.push(macroNodeId);
      }
    },
    exit(path) {
      const { callee } = path.node;

      if (
        t.isIdentifier(callee) &&
        this.macros.some((m) => m === callee.name)
      ) {
        const activeMacro = this.graph.getNode(this.activeMacros.pop());
        path.replaceWith(t.identifier(activeMacro.injectedIndentifier));
      }
    },
  },
};
export interface Store {
  buildTimeStatements: Array<t.Statement>;
}

interface PluginOptions {
  store: Store;
  macros: Array<string>;
}

interface Context extends PluginPass {
  macroReferences: Set<string>;
  identifierCount: number;
  injectedStatements: DefaultMap<number, Array<t.Statement>>;
  createVanillaIdentifierName: () => string;
  isMacroCallExpression: (
    path: NodePath<t.CallExpression>,
  ) => path is NodePath<t.CallExpression>;
  opts: PluginOptions;
}

// traverse CallExpression to find all macros
// Find which refs are used by the macros
// Are those refs imports?
// If so, are those imports used elewhere

const macroVisitor: Visitor<Context> = {
  CallExpression(path) {
    if (this.isMacroCallExpression(path)) {
      for (const arg of path.get('arguments')) {
        arg.traverse(
          {
            Identifier({ node }) {
              this.macroReferences.add(node.name);
            },
          },
          this,
        );
      }

      const injectedIndentifier = t.identifier(
        this.createVanillaIdentifierName(),
      );
      const declaration = t.exportNamedDeclaration(
        t.variableDeclaration('const', [
          t.variableDeclarator(injectedIndentifier, path.node),
        ]),
      );
      const statementIndex = getStatementIndex(path);

      this.injectedStatements.get(statementIndex).push(declaration);
      path.replaceWith(injectedIndentifier);
    }
  },
};

const statementContentKey = (index: number) => `statement:${index}`;

const vanillaDefaultIdentifier = '_vanilla_defaultIdentifer';

type Node =
  | { type: 'module-root' }
  | { type: 'macro-root' }
  | { type: 'statement' }
  | { type: 'macro'; name: string; ast: t.CallExpression }
  | { type: 'import'; local: string };

export default function (): PluginObj<Context> {
  return {
    pre() {
      this.macroReferences = new Set();
      this.identifierCount = 0;
      this.injectedStatements = new DefaultMap(() => []);
    },
    visitor: {
      Program: {
        enter(path, state) {
          const { macros, store } = state.opts;

          invariant(macros.length > 0, 'Must define at least one macro');

          this.isMacroCallExpression = (
            path: NodePath<t.CallExpression>,
          ): path is NodePath<t.CallExpression> =>
            t.isIdentifier(path.node.callee) &&
            macros.includes(path.node.callee.name);

          this.createVanillaIdentifierName = () =>
            `_vanilla_identifier_${this.identifierCount++}`;

          path.traverse(macroVisitor, this);

          const bodyPath = path.get('body');
          for (const statementIndex of bodyPath.keys()) {
            const statement = bodyPath[statementIndex];

            for (const injectedStatment of this.injectedStatements.get(
              statementIndex,
            )) {
              store.buildTimeStatements.push(injectedStatment);
            }

            store.buildTimeStatements.push(statement.node);
          }

          //   for (const statementIndex of bodyPath.keys()) {
          //     const statement = bodyPath[statementIndex];
          //     const statementNodeId = this.graph.addNodeByContentKey(
          //       statementContentKey(statementIndex),
          //       { type: 'statement' },
          //     );
          //     this.graph.addEdge(this.moduleRootNode, statementNodeId);

          //     const declaredNodeIds = [];
          //     // Find which idents are declared by this statement
          //     // add all delcared idents to graph
          //     statement.traverse(declarationVisitor, {
          //       ...this,
          //       declaredNodeIds,
          //       statementNodeId,
          //     });

          //     // Attach all references to graph
          //     statement.traverse(referenceVisitor, {
          //       ...this,
          //       parentNodeIds: declaredNodeIds,
          //       activeMacros: [],
          //       statementNodeId,
          //     });
          //   }

          //   const isUsedInMacro = (identName: string) => {
          //     console.log('isUsedInMacro', identName);
          //     let isUsed = false;

          //     this.graph.traverse((nodeId, _, actions) => {
          //       const node = this.graph.getNode(nodeId);
          //       console.log(node.local);

          //       if (node.local === identName) {
          //         isUsed = true;
          //         actions.stop();
          //       }
          //     }, this.macroRootNode);

          //     return isUsed;
          //   };

          //   for (const statementIndex of Array.from(bodyPath.keys()).reverse()) {
          //     const statementNodeId = this.graph.getNodeIdByContentKey(
          //       statementContentKey(statementIndex),
          //     );

          //     const declaredIdents =
          //       this.graph.getNodeIdsConnectedFrom(statementNodeId);

          //     const shouldRemove =
          //       declaredIdents.length > 0 &&
          //       declaredIdents
          //         .map((nodeId) => [nodeId, this.graph.getNode(nodeId)])
          //         .filter(([, node]) => node.type !== 'macro')
          //         .every(([nodeId, { local }]) => {
          //           // Is is used in a macros?
          //           // const isUsedInMacro =
          //           // and
          //           // Is it not used at runtime?

          //           return isUsedInMacro(local);
          //         });

          //     const statement = bodyPath[statementIndex];

          //     store.buildTimeStatements.push(statement.node);

          //     declaredIdents
          //       .map((nodeId) => this.graph.getNode(nodeId))
          //       .filter((node) => node.type === 'macro')
          //       .forEach(({ ast, injectedIndentifier }) => {
          //         const declaration = t.exportNamedDeclaration(
          //           t.variableDeclaration('const', [
          //             t.variableDeclarator(
          //               t.identifier(injectedIndentifier),
          //               ast,
          //             ),
          //           ]),
          //         );
          //         store.buildTimeStatements.push(declaration);
          //       });

          //     if (shouldRemove) {
          //       statement.remove();
          //     }
          //   }

          //   store.buildTimeStatements.reverse();
        },
      },
    },
  };
}

function getStatementIndex(path: NodePath<t.CallExpression>): number {
  const pathLocation = path.getStatementParent()?.getPathLocation();
  invariant(pathLocation != null, 'Could not get statment parent of macro');

  const indexMatch = pathLocation.match(/program.body\[(\d+)]/);
  invariant(indexMatch != null, 'Could not parse path location');

  return parseInt(indexMatch[1], 10);
}