import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Card, CardTitle, KeyValue, Pill, Screen, SectionTitle, uiStyles } from '../../src/components/ui';
import { fetchProductPlan, fetchHouseholdInterest, setHouseholdInterest, type ProductPlanResponse } from '../../src/api/apmApi';
import { useSession } from '../../src/state/session';

export default function PlanScreen() {
  const { accessToken } = useSession();
  const [product, setProduct] = useState<ProductPlanResponse>();
  const [householdInterested, setHouseholdInterestedState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    Promise.all([fetchProductPlan(accessToken), fetchHouseholdInterest(accessToken)])
      .then(([plan, interest]) => {
        if (!active) return;
        setProduct(plan);
        setHouseholdInterestedState(interest.interested);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : 'Unable to load your plan.');
      });
    return () => { active = false; };
  }, [accessToken]);

  const changeHouseholdInterest = async () => {
    if (!accessToken || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = !householdInterested;
      const result = await setHouseholdInterest(next, accessToken);
      setHouseholdInterestedState(result.interested);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update Household interest.');
    } finally {
      setBusy(false);
    }
  };

  const currentPlan = product?.entitlement.plan ?? 'beta';

  return (
    <Screen
      eyebrow="Your plan"
      title="Choose how much responsibility APM carries."
      subtitle="One A Player Mode. Three individual service levels. Upgrading makes capability available; it never grants action permission by itself."
    >
      {error ? <Card tone="danger"><Body>{error}</Body></Card> : null}

      <Card tone="accent">
        <CardTitle>{product?.entitlement.displayName ?? 'Loading your plan…'}</CardTitle>
        {product ? (
          <>
            <KeyValue label="Status" value={product.entitlement.status} />
            <KeyValue label="Maximum autonomy" value={`${product.entitlement.maxAutonomyLevel} · ${product.entitlement.maxAutonomyLabel}`} />
            <Body muted>{product.entitlement.promise}</Body>
          </>
        ) : null}
      </Card>

      <SectionTitle>Individual plans</SectionTitle>
      <View style={uiStyles.stack}>
        {product?.plans.filter((plan) => plan.publicAvailability === 'available').map((plan) => (
          <Card key={plan.plan} tone={plan.plan === currentPlan ? 'accent' : 'default'}>
            <View style={uiStyles.row}>
              <CardTitle>{plan.displayName}</CardTitle>
              {plan.plan === currentPlan ? <Pill tone="success">Current</Pill> : <Pill>Available tier</Pill>}
            </View>
            <Body>{plan.promise}</Body>
            <KeyValue label="Price" value={plan.priceLabel} />
            <KeyValue label="Autonomy ceiling" value={`${plan.maxAutonomyLevel} · ${plan.maxAutonomyLabel}`} />
            {plan.highlights.map((highlight) => <Body key={highlight} muted>• {highlight}</Body>)}
            {plan.plan !== currentPlan ? <Body muted>Purchase/upgrade activation will use verified billing receipts; this build does not fake a plan change locally.</Body> : null}
          </Card>
        ))}
      </View>

      <SectionTitle>Household</SectionTitle>
      <Card tone="muted">
        <View style={uiStyles.row}>
          <CardTitle>Household OS</CardTitle>
          <Pill tone="warning">Later</Pill>
        </View>
        <Body>Coordinate shared calendars, responsibilities and mental load across a household. We are not activating Household yet.</Body>
        <Body muted>Your interest helps determine when we build the collaborative product. Joining this list grants no Household access or authority.</Body>
        <Button
          label={busy ? 'Saving…' : householdInterested ? 'Remove me from Household interest list' : 'I’m interested in Household OS'}
          variant="secondary"
          onPress={() => void changeHouseholdInterest()}
        />
      </Card>
    </Screen>
  );
}
