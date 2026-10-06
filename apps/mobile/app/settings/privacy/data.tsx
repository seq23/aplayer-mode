import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { LifeAdminItem, LifeRelationship } from '@apm/domain';
import {
  Body,
  Button,
  Card,
  CardTitle,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../../src/components/ui';
import { fetchRetainedLifeOsState } from '../../../src/api/apmApi';
import { useLifeGraph } from '../../../src/state/lifeGraph';
import { useSession } from '../../../src/state/session';

export default function YourDataScreen() {
  const { graph } = useLifeGraph();
  const { accessToken } = useSession();
  const [retainedLifeRelationships, setRetainedLifeRelationships] = useState<LifeRelationship[]>(graph.lifeRelationships);
  const [retainedLifeAdminItems, setRetainedLifeAdminItems] = useState<LifeAdminItem[]>(graph.lifeAdminItems);
  const [lifeOsReadError, setLifeOsReadError] = useState<string>();

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    fetchRetainedLifeOsState(accessToken)
      .then((result) => {
        if (!active) return;
        setRetainedLifeRelationships(result.lifeRelationships);
        setRetainedLifeAdminItems(result.lifeAdminItems);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLifeOsReadError(cause instanceof Error ? cause.message : 'Unable to load retained Life OS data.');
      });
    return () => { active = false; };
  }, [accessToken, graph.lifeRelationships, graph.lifeAdminItems]);

  const editPersonalOS = () => router.push('/onboarding');

  return (
    <Screen
      eyebrow="Your Data"
      title="What APM knows about you."
      subtitle="Important persistent state is inspectable with source context. Core stated profile/goal state can be corrected by updating your Personal OS intake."
    >
      <Card tone="accent">
        <CardTitle>Your Life Graph is APM's private operating memory.</CardTitle>
        <Body muted>Roles, goals, commitments, routines, people, relationships, Life OS obligations, preferences and rules live in structured state instead of being hidden inside a giant prompt.</Body>
      </Card>

      <SectionTitle>Identity & game</SectionTitle>
      <Card>
        <View style={uiStyles.row}><Pill>Identity</Pill><Pill tone="success">User stated</Pill></View>
        <CardTitle>{graph.identity.displayName || 'Not set'}</CardTitle>
        {graph.identity.currentSeason ? <KeyValue label="Current season" value={graph.identity.currentSeason} /> : null}
        {graph.identity.becoming ? <KeyValue label="Becoming" value={graph.identity.becoming} /> : null}
        <KeyValue label="Source" value="Personal OS intake" />
        <Button label="Correct my Personal OS" variant="secondary" onPress={editPersonalOS} />
      </Card>

      {graph.roles.map((role) => (
        <Card key={role.id}>
          <View style={uiStyles.row}><Pill>Role / game</Pill><Pill tone="success">{role.provenance.kind}</Pill></View>
          <CardTitle>{role.name}</CardTitle>
          <KeyValue label="Status" value={role.active ? 'Active now' : 'Inactive'} />
          <KeyValue label="Source" value={role.provenance.sourceType} />
        </Card>
      ))}

      <SectionTitle>Goals</SectionTitle>
      {graph.goals.length ? graph.goals.map((goal) => (
        <Card key={goal.id}>
          <View style={uiStyles.row}><Pill>Goal</Pill><Pill tone="success">{Math.round((goal.provenance.confidence ?? 1) * 100)}% confidence</Pill></View>
          <CardTitle>{goal.title}</CardTitle>
          <KeyValue label="Pillar" value={goal.pillar ?? 'Not set'} />
          <KeyValue label="Health" value={goal.health.replace('_', ' ')} />
          <KeyValue label="Source" value={goal.provenance.sourceType} />
        </Card>
      )) : <Card><Body muted>No goals are stored yet.</Body></Card>}

      <SectionTitle>Commitments APM can currently see</SectionTitle>
      {graph.commitments.length ? graph.commitments.slice(0, 20).map((commitment) => (
        <Card key={commitment.id}>
          <View style={uiStyles.row}><Pill>Commitment</Pill><Pill>{commitment.provenance.sourceType}</Pill></View>
          <CardTitle>{commitment.title}</CardTitle>
          <KeyValue label="Owner" value={commitment.owner} />
          <KeyValue label="Status" value={commitment.status} />
          <KeyValue label="Due" value={commitment.dueAt ?? 'No due date'} />
          <KeyValue label="Confidence" value={`${Math.round((commitment.provenance.confidence ?? 1) * 100)}%`} />
        </Card>
      )) : <Card><Body muted>No commitments are stored yet.</Body></Card>}

      <SectionTitle>Life OS</SectionTitle>
      {lifeOsReadError ? <Card tone="warning"><Body>{lifeOsReadError}</Body></Card> : null}
      {retainedLifeRelationships.length ? retainedLifeRelationships.slice(0, 20).map((relationship) => {
        const person = graph.people.find((candidate) => candidate.id === relationship.personId);
        return (
          <Card key={relationship.id}>
            <View style={uiStyles.row}><Pill>Relationship</Pill><Pill tone="success">{relationship.provenance.kind}</Pill></View>
            <CardTitle>{person?.name ?? 'Person'}</CardTitle>
            <KeyValue label="Relationship" value={person?.relationship ?? 'Not set'} />
            <KeyValue label="Birthday" value={relationship.birthday ?? 'Not set'} />
            <KeyValue label="Next contact" value={relationship.nextContactAt ?? 'Not set'} />
            <KeyValue label="Source" value={relationship.provenance.sourceType} />
          </Card>
        );
      }) : <Card><Body muted>No Life OS relationship state is stored.</Body></Card>}

      {retainedLifeAdminItems.length ? retainedLifeAdminItems.slice(0, 20).map((item) => (
        <Card key={item.id}>
          <View style={uiStyles.row}><Pill>Life OS</Pill><Pill>{item.kind.replaceAll('_', ' ')}</Pill></View>
          <CardTitle>{item.title}</CardTitle>
          <KeyValue label="Status" value={item.status} />
          <KeyValue label="Next date" value={item.dueAt ?? item.startsAt ?? 'Not set'} />
          <KeyValue label="Source" value={item.provenance.sourceType} />
        </Card>
      )) : <Card><Body muted>No Life OS administration items are stored.</Body></Card>}

      <Card>
        <Body muted>Life OS state is private structured data. Use Life OS to correct or complete it; export and account deletion include this state through the same Life Graph lifecycle.</Body>
        <Button label="Manage Life OS" variant="secondary" onPress={() => router.push('/settings/life')} />
      </Card>

      <SectionTitle>Operating rules & preferences</SectionTitle>
      <Card>
        <KeyValue label="Routines" value={String(graph.routines.length)} />
        <KeyValue label="People" value={String(graph.people.length)} />
        <KeyValue label="Life relationships" value={String(retainedLifeRelationships.length)} />
        <KeyValue label="Life admin items" value={String(retainedLifeAdminItems.length)} />
        <KeyValue label="Preferences" value={String(graph.preferences.length)} />
        <KeyValue label="Rules" value={String(graph.rules.length)} />
        <KeyValue label="Connected accounts" value={String(graph.connections.length)} />
      </Card>

      <Card tone="warning">
        <CardTitle>Correction requirement</CardTitle>
        <Body>Stated identity/goal state can be corrected by reinstalling the Personal OS. Provider-derived commitments must retain source/confidence and will gain item-level correction controls before public launch; corrections must not be blindly recreated from stale source evidence.</Body>
      </Card>
    </Screen>
  );
}
