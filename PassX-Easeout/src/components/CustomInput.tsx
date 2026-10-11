import React from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import colors from '../constants/colors';

// This gets the valid icon names from the library
type IconName = keyof typeof Ionicons.glyphMap;

interface CustomInputProps {
  placeholder: string;
  icon: IconName;
  secureTextEntry?: boolean;
  value: string;
  onChangeText: (text: string) => void;
}

const CustomInput: React.FC<CustomInputProps> = ({ 
  placeholder, 
  icon, 
  secureTextEntry, 
  value, 
  onChangeText 
}) => {
  return (
    <View style={styles.container}>
      <Ionicons name={icon} size={20} color={colors.textLight} style={styles.icon} />
      <TextInput 
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={colors.textLight}
        secureTextEntry={secureTextEntry}
        value={value}
        onChangeText={onChangeText}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.inputBg,
    borderRadius: 10,
    paddingHorizontal: 15,
    marginVertical: 10,
    height: 55,
  },
  icon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    color: colors.textDark,
    fontSize: 15,
  },
});

export default CustomInput;