/**
 * Deployment: an authored view becomes an `aws-native.connect.View`, showable from a flow.
 *
 * The classic `aws` provider has no View resource — still true as of 7.41 — so this is the one place
 * the library reaches for `@pulumi/aws-native`, which mirrors `AWS::Connect::View`.
 *
 * The resource is showable itself, which is the point: a view deployed here has no id until Pulumi
 * creates it, and `show` embeds a deferred token that `ContactFlow` resolves. Nothing has to be
 * redeclared, so the template, the data the flow passes in, the values it reads back and the actions
 * it handles all come from the same `defineView` call.
 */

import * as awsNative from "@pulumi/aws-native";
import * as pulumi from "@pulumi/pulumi";
import type { ViewResult } from "../flow/refs.js";
import {
  type ShowArgs,
  type ShowableView,
  showableView,
  type ViewInput,
  type ViewOutput,
} from "../view/connectView.js";
import type { DefinedView } from "../view/template.js";

export interface ConnectViewArgs<In extends ViewInput, Out extends ViewOutput, A extends string> {
  /**
   * The Connect instance ARN.
   *
   * An ARN rather than the id every other resource here takes, because that is what
   * `AWS::Connect::View` requires.
   */
  instanceArn: pulumi.Input<string>;
  /** The view, from `defineView`. Supplies the template, the actions and the types. */
  view: DefinedView<In, Out, A>;
  /** Defaults to the Pulumi resource name. Connect restricts view names to a narrow character set. */
  name?: pulumi.Input<string>;
  description?: pulumi.Input<string>;
  tags?: pulumi.Input<Array<pulumi.Input<awsNative.types.input.TagArgs>>>;
  /**
   * Which version of the view a flow shows. Defaults to `$LATEST`.
   *
   * `$LATEST` is what console-exported flows reference.
   */
  viewVersion?: string | number;
  /** Default time to wait for the participant, overridable per `show`. */
  timeoutSeconds?: number;
}

/**
 * A view authored in TypeScript, deployed and ready to show.
 *
 * ```ts
 * const picker = new ConnectView("order-picker", { instanceArn: instance.arn, view: orderPicker });
 *
 * // inside a flow
 * const result = picker.show({
 *   data: { customerName: attr("name") },
 *   on: { OrderSelected: (r) => setAttributes({ id: r.OrderTable.at(0).order_id }) },
 * });
 * ```
 */
export class ConnectView<In extends ViewInput, Out extends ViewOutput, A extends string>
  extends pulumi.ComponentResource
  implements ShowableView<In, Out, A>
{
  readonly view: awsNative.connect.View;
  readonly viewId: pulumi.Output<string>;
  readonly viewArn: pulumi.Output<string>;
  readonly actions: readonly A[];

  private readonly showable: ShowableView<In, Out, A>;

  constructor(
    name: string,
    args: ConnectViewArgs<In, Out, A>,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("pulumi-amazon-connect:index:ConnectView", name, {}, opts);

    this.view = new awsNative.connect.View(
      name,
      {
        instanceArn: args.instanceArn,
        name: args.name ?? name,
        // The template goes over the wire as an object here, unlike `CreateView`, which takes a string.
        template: args.view.Template,
        actions: args.view.Actions,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
      },
      { parent: this },
    );

    this.viewId = this.view.viewId;
    this.viewArn = this.view.viewArn;
    this.actions = args.view.actions;

    this.showable = showableView<In, Out, A>({
      label: name,
      // The ARN is a Pulumi output, so the flow embeds a deferred token that ContactFlow
      // substitutes once Pulumi knows the real value. Resolved lazily: allocating the token needs
      // the recorder that is active during `show`.
      resolveViewId: () => this.viewArn,
      actions: args.view.actions,
      viewVersion: args.viewVersion ?? "$LATEST",
      ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
    });

    this.registerOutputs({ viewId: this.viewId, viewArn: this.viewArn });
  }

  /** Shows the view from a flow, returning references to what the participant submitted. */
  show(args: ShowArgs<In, Out, A>): ViewResult<Out, A> {
    return this.showable.show(args);
  }
}
