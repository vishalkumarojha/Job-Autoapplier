import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import colors from '../../constants/colors';

// Define the 8 features you requested
const features = [
  { id: 1, name: 'Passwords', icon: 'key', color: '#FF6B6B', route: 'PasswordManager' },
  { id: 2, name: 'Job Apps', icon: 'briefcase', color: '#4ECDC4', route: 'JobTracker' },
  { id: 3, name: 'Goals (AI)', icon: 'rocket', color: '#1A535C', route: 'Goals' },
  { id: 4, name: 'Projects', icon: 'folder-open', color: '#FFE66D', route: 'Projects' },
  { id: 5, name: 'Study', icon: 'book', color: '#FF9F1C', route: 'StudyPlan' },
  { id: 6, name: 'Calendar', icon: 'calendar', color: '#264653', route: 'Calendar' },
  { id: 7, name: 'Profiles', icon: 'share-social', color: '#2A9D8F', route: 'Profiles' },
  { id: 8, name: 'Spaces', icon: 'layers', color: '#F4A261', route: 'CustomSpaces' },
  { id: 9, name: 'Job Pipeline', icon: 'git-branch-outline', color: '#264653', route: 'JobPipeline' },
];

const QuickAccessGrid = ({ navigation }: any) => {
  return (
    <View style={styles.gridContainer}>
      {features.map((item) => (
        <TouchableOpacity 
          key={item.id} 
          style={styles.gridItem} 
          onPress={() => navigation.navigate(item.route)}
        >
          <View style={[styles.iconCircle, { backgroundColor: item.color + '20' }]}> 
            {/* The '20' adds transparency to the hex code */}
            <Ionicons name={item.icon as any} size={24} color={item.color} />
          </View>
          <Text style={styles.itemText}>{item.name}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  gridItem: {
    width: '23%', // Fits 4 items per row approximately
    alignItems: 'center',
    marginBottom: 20,
  },
  iconCircle: {
    width: 55,
    height: 55,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  itemText: {
    fontSize: 12,
    color: colors.textDark,
    textAlign: 'center',
    fontWeight: '500'
  }
});

export default QuickAccessGrid;